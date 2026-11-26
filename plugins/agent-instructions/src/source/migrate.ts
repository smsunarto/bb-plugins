import { lstat, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { globalText } from "../catalog/publish.ts";
import { treeSha } from "../catalog/tree.ts";
import { rulesStateSchema, type Rule } from "../shared/rules.ts";
import {
  ensureSourceFolders,
  isSafeSyncPath,
  readSyncFile,
  sha256Bytes,
  walkSyncTree,
  writeSyncFileAtomic,
} from "../sync/paths.ts";
import {
  compareOrdered,
  ITEM_ID_PATTERN,
  parseDocFile,
  parseRuleFile,
  sanitizeDocId,
  serializeDocFile,
  serializeRuleFile,
} from "./format.ts";

/** Minimal synchronous read-only SQLite interface (works with better-sqlite3 and bun:sqlite). */
export type ReadOnlySqlite = {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
};

export type LegacyDoc = {
  id: string;
  name: string;
  body: string;
  enabled: boolean;
  position: number;
};

export type LegacySkillFile = {
  path: string;
  executable: boolean;
  sha256: string;
  bytes: Uint8Array;
};

export type LegacySkill = {
  name: string;
  description: string;
  enabled: boolean;
  treeSha: string;
  files: LegacySkillFile[];
};

export type LegacyDeleted = {
  kind: "skill" | "doc";
  key: string;
  name: string;
  at: number;
};

export type LegacyData = {
  docs: LegacyDoc[];
  skills: LegacySkill[];
  rules: Rule[];
  deleted: LegacyDeleted[];
};

export type PlannedFile = {
  relPath: string;
  executable: boolean;
  bytes: Uint8Array;
  sha256: string;
};

export type MigrationPlan = {
  docs: { legacyId: string; id: string; relPath: string; name: string; enabled: boolean }[];
  rules: { id: string; relPath: string; name: string; enabled: boolean }[];
  skills: { name: string; enabled: boolean; fileCount: number; treeSha: string }[];
  skippedDeleted: LegacyDeleted[];
  files: PlannedFile[];
  expectedAgentsMdSha256: string | null;
  errors: string[];
};

export type MigrationVerification = {
  ok: boolean;
  docsChecked: number;
  rulesChecked: number;
  skillsChecked: number;
  skillFilesChecked: number;
  agentsMdMatched: boolean;
  mismatches: string[];
};

export type MigrationReport = {
  dryRun: boolean;
  applied: boolean;
  targetDir: string;
  plan: Omit<MigrationPlan, "files"> & { fileCount: number; totalBytes: number };
  verification: MigrationVerification;
};

function tableExists(db: ReadOnlySqlite, name: string): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { ok: number } | undefined;
  return row?.ok === 1;
}

/** Reads legacy catalog docs, skills, skill_files, and tombstones without writing anything. */
export function readLegacySqlite(db: ReadOnlySqlite): Omit<LegacyData, "rules"> {
  const docs: LegacyDoc[] = tableExists(db, "instruction_docs")
    ? (
        db
          .prepare(
            "SELECT id, name, body, enabled, position FROM instruction_docs ORDER BY position, id",
          )
          .all() as { id: string; name: string; body: string; enabled: number; position: number }[]
      ).map((row) => ({
        id: row.id,
        name: row.name,
        body: row.body,
        enabled: row.enabled === 1,
        position: row.position,
      }))
    : [];

  const fileRows = tableExists(db, "skill_files")
    ? (db
        .prepare(
          "SELECT skill, path, executable, sha256, bytes FROM skill_files ORDER BY skill, path",
        )
        .all() as {
        skill: string;
        path: string;
        executable: number;
        sha256: string;
        bytes: Uint8Array;
      }[])
    : [];
  const bySkill = new Map<string, LegacySkillFile[]>();
  for (const row of fileRows) {
    const bytes = new Uint8Array(row.bytes);
    const list = bySkill.get(row.skill) ?? [];
    list.push({
      path: row.path,
      executable: row.executable === 1,
      sha256: row.sha256,
      bytes,
    });
    bySkill.set(row.skill, list);
  }

  const skills: LegacySkill[] = tableExists(db, "skills")
    ? (
        db
          .prepare("SELECT name, description, enabled, tree_sha FROM skills ORDER BY name")
          .all() as { name: string; description: string; enabled: number; tree_sha: string }[]
      ).map((row) => ({
        name: row.name,
        description: row.description,
        enabled: row.enabled === 1,
        treeSha: row.tree_sha,
        files: bySkill.get(row.name) ?? [],
      }))
    : [];

  const deleted: LegacyDeleted[] = tableExists(db, "catalog_deleted")
    ? (db
        .prepare("SELECT kind, key, name, at FROM catalog_deleted ORDER BY at DESC")
        .all() as LegacyDeleted[])
    : [];

  return { docs, skills, deleted };
}

/** Parses legacy rules from plugin KV `state` (or `{ rules: [...] }` JSON). */
export function parseLegacyRules(raw: unknown): Rule[] {
  if (raw === null || raw === undefined) return [];
  const full = rulesStateSchema.safeParse(raw);
  if (full.success) return full.data.rules;
  if (typeof raw === "object" && "rules" in raw) {
    const withDefaultRev = rulesStateSchema.safeParse({
      revision: 0,
      rules: (raw as { rules: unknown }).rules,
    });
    if (withDefaultRev.success) return withDefaultRev.data.rules;
  }
  throw new Error("Unreadable legacy rules payload");
}

/**
 * Plans the lossless export of legacy docs, skills, and rules into plain files.
 * Verifies in-memory round-trip parsing of every doc and rule before anything touches disk.
 */
export function planMigration(data: LegacyData): MigrationPlan {
  const errors: string[] = [];
  const files: PlannedFile[] = [];
  const usedPaths = new Set<string>();
  const usedDocIds = new Set<string>();
  const plannedDocs: MigrationPlan["docs"] = [];
  const plannedRules: MigrationPlan["rules"] = [];
  const plannedSkills: MigrationPlan["skills"] = [];

  const addFile = (relPath: string, bytes: Uint8Array, executable: boolean) => {
    if (!isSafeSyncPath(relPath)) {
      errors.push(`Refused unsafe target path: ${relPath}`);
      return;
    }
    const lower = relPath.toLowerCase();
    if (usedPaths.has(lower)) {
      errors.push(`Target path collision: ${relPath}`);
      return;
    }
    usedPaths.add(lower);
    files.push({ relPath, executable, bytes, sha256: sha256Bytes(bytes) });
  };

  // 1. Global instruction docs
  data.docs.forEach((doc, index) => {
    let id = sanitizeDocId(doc.id);
    if (usedDocIds.has(id.toLowerCase())) {
      let suffix = 2;
      while (usedDocIds.has(`${id}-${suffix}`.toLowerCase())) suffix++;
      id = `${id}-${suffix}`;
    }
    usedDocIds.add(id.toLowerCase());
    const relPath = `instructions/${id}.md`;
    const serialized = serializeDocFile({
      id,
      name: doc.name,
      enabled: doc.enabled,
      order: index,
      body: doc.body,
      hasFrontmatter: true,
    });
    const roundTrip = parseDocFile(id, serialized);
    if (
      roundTrip.name !== doc.name ||
      roundTrip.enabled !== doc.enabled ||
      roundTrip.order !== index ||
      roundTrip.body !== doc.body
    ) {
      errors.push(`Doc ${doc.id} failed lossless round-trip check`);
    }
    addFile(relPath, Buffer.from(serialized, "utf8"), false);
    plannedDocs.push({ legacyId: doc.id, id, relPath, name: doc.name, enabled: doc.enabled });
  });

  // 2. Scoped rules
  const usedRuleIds = new Set<string>();
  data.rules.forEach((rule, index) => {
    if (!ITEM_ID_PATTERN.test(rule.id)) {
      errors.push(`Rule id ${JSON.stringify(rule.id)} is not a safe filename stem`);
      return;
    }
    if (usedRuleIds.has(rule.id.toLowerCase())) {
      errors.push(`Duplicate rule id (case-insensitive): ${rule.id}`);
      return;
    }
    usedRuleIds.add(rule.id.toLowerCase());
    const relPath = `rules/${rule.id}.md`;
    const serialized = serializeRuleFile(rule, index);
    const roundTrip = parseRuleFile(rule.id, serialized);
    if ("error" in roundTrip) {
      errors.push(`Rule ${rule.id} failed round-trip parse: ${roundTrip.error}`);
    } else if (
      JSON.stringify(roundTrip.rule) !== JSON.stringify(rule) ||
      roundTrip.order !== index
    ) {
      errors.push(`Rule ${rule.id} failed lossless round-trip equality`);
    }
    addFile(relPath, Buffer.from(serialized, "utf8"), false);
    plannedRules.push({ id: rule.id, relPath, name: rule.name, enabled: rule.enabled });
  });

  // 3. Skills (raw bytes preserved verbatim)
  for (const skill of data.skills) {
    for (const file of skill.files) {
      const actualSha = sha256Bytes(file.bytes);
      if (actualSha !== file.sha256) {
        errors.push(`Skill ${skill.name}/${file.path} stored sha256 disagrees with bytes`);
      }
      addFile(`skills/${skill.name}/${file.path}`, file.bytes, file.executable);
    }
    if (!skill.enabled) {
      addFile(`skills/${skill.name}/.disabled`, new Uint8Array(), false);
    }
    plannedSkills.push({
      name: skill.name,
      enabled: skill.enabled,
      fileCount: skill.files.length,
      treeSha: skill.treeSha,
    });
  }

  const agentsText = globalText(data.docs);
  return {
    docs: plannedDocs,
    rules: plannedRules,
    skills: plannedSkills,
    skippedDeleted: data.deleted,
    files,
    expectedAgentsMdSha256: agentsText === null ? null : sha256Bytes(agentsText),
    errors,
  };
}

/** Verifies an in-memory plan (for dry-run) or the files written on disk (for apply). */
export async function verifyMigration(
  data: LegacyData,
  plan: MigrationPlan,
  targetDir: string | null,
): Promise<MigrationVerification> {
  const mismatches: string[] = [];
  const plannedByPath = new Map(plan.files.map((f) => [f.relPath, f]));

  async function readEntry(
    relPath: string,
  ): Promise<{ bytes: Uint8Array; executable: boolean; sha256: string } | null> {
    if (targetDir === null) {
      const planned = plannedByPath.get(relPath);
      return planned
        ? { bytes: planned.bytes, executable: planned.executable, sha256: planned.sha256 }
        : null;
    }
    const onDisk = await readSyncFile(targetDir, relPath);
    return onDisk
      ? { bytes: onDisk.bytes, executable: onDisk.executable, sha256: onDisk.sha256 }
      : null;
  }

  // Verify docs
  const parsedDocs: { body: string; enabled: boolean; order: number | undefined; id: string }[] =
    [];
  for (let i = 0; i < data.docs.length; i++) {
    const legacy = data.docs[i]!;
    const planned = plan.docs[i];
    if (!planned) {
      mismatches.push(`Missing planned doc for ${legacy.id}`);
      continue;
    }
    const entry = await readEntry(planned.relPath);
    if (!entry) {
      mismatches.push(`Missing exported doc file ${planned.relPath}`);
      continue;
    }
    const parsed = parseDocFile(planned.id, Buffer.from(entry.bytes).toString("utf8"));
    parsedDocs.push({
      id: parsed.id,
      body: parsed.body,
      enabled: parsed.enabled,
      order: parsed.order,
    });
    if (parsed.name !== legacy.name)
      mismatches.push(`Doc ${legacy.id} name mismatch: ${parsed.name} !== ${legacy.name}`);
    if (parsed.enabled !== legacy.enabled) mismatches.push(`Doc ${legacy.id} enabled mismatch`);
    if (parsed.body !== legacy.body)
      mismatches.push(`Doc ${legacy.id} body mismatch (bytes differ)`);
  }
  parsedDocs.sort(compareOrdered);
  const actualAgents = globalText(parsedDocs);
  const actualAgentsSha = actualAgents === null ? null : sha256Bytes(actualAgents);
  const agentsMdMatched = actualAgentsSha === plan.expectedAgentsMdSha256;
  if (!agentsMdMatched)
    mismatches.push(
      `Published AGENTS.md sha256 mismatch: ${actualAgentsSha} !== ${plan.expectedAgentsMdSha256}`,
    );

  // Verify rules
  const parsedRules: { id: string; order: number | undefined; rule: Rule }[] = [];
  for (const legacy of data.rules) {
    const relPath = `rules/${legacy.id}.md`;
    const entry = await readEntry(relPath);
    if (!entry) {
      mismatches.push(`Missing exported rule file ${relPath}`);
      continue;
    }
    const parsed = parseRuleFile(legacy.id, Buffer.from(entry.bytes).toString("utf8"));
    if ("error" in parsed) {
      mismatches.push(`Rule ${legacy.id} parse error: ${parsed.error}`);
      continue;
    }
    parsedRules.push({ id: legacy.id, order: parsed.order, rule: parsed.rule });
  }
  parsedRules.sort(compareOrdered);
  if (parsedRules.length !== data.rules.length) {
    mismatches.push(`Rule count mismatch: ${parsedRules.length} !== ${data.rules.length}`);
  } else {
    for (let i = 0; i < data.rules.length; i++) {
      if (JSON.stringify(parsedRules[i]!.rule) !== JSON.stringify(data.rules[i])) {
        mismatches.push(`Rule ${data.rules[i]!.id} at index ${i} differs after export`);
      }
    }
  }

  // Verify skills byte-for-byte
  let skillFilesChecked = 0;
  for (const skill of data.skills) {
    const hashed: { path: string; executable: boolean; sha256: string }[] = [];
    for (const file of skill.files) {
      const relPath = `skills/${skill.name}/${file.path}`;
      const entry = await readEntry(relPath);
      if (!entry) {
        mismatches.push(`Missing exported skill file ${relPath}`);
        continue;
      }
      if (
        entry.sha256 !== file.sha256 ||
        !Buffer.from(entry.bytes).equals(Buffer.from(file.bytes))
      ) {
        mismatches.push(`Skill file ${relPath} bytes mismatch`);
      }
      if (entry.executable !== file.executable) {
        mismatches.push(`Skill file ${relPath} executable bit mismatch`);
      }
      hashed.push({ path: file.path, executable: entry.executable, sha256: entry.sha256 });
      skillFilesChecked++;
    }
    const actualTreeSha = treeSha(hashed);
    if (actualTreeSha !== skill.treeSha) {
      mismatches.push(
        `Skill ${skill.name} treeSha mismatch: ${actualTreeSha} !== ${skill.treeSha}`,
      );
    }
    const disabledEntry = await readEntry(`skills/${skill.name}/.disabled`);
    if (skill.enabled && disabledEntry !== null)
      mismatches.push(`Enabled skill ${skill.name} unexpectedly has .disabled`);
    if (!skill.enabled && disabledEntry === null)
      mismatches.push(`Disabled skill ${skill.name} missing .disabled marker`);
  }

  // When verified on disk, ensure no unexpected extra files were written.
  if (targetDir !== null) {
    const walked = await walkSyncTree(targetDir);
    const actualPaths = Object.keys(walked.manifest).sort();
    const expectedPaths = plan.files.map((f) => f.relPath).sort();
    for (const p of actualPaths) {
      if (!plannedByPath.has(p)) mismatches.push(`Unexpected extra file on disk: ${p}`);
    }
    if (actualPaths.length !== expectedPaths.length) {
      mismatches.push(
        `Total file count mismatch: ${actualPaths.length} on disk !== ${expectedPaths.length} planned`,
      );
    }
  }

  return {
    ok: mismatches.length === 0 && plan.errors.length === 0,
    docsChecked: data.docs.length,
    rulesChecked: data.rules.length,
    skillsChecked: data.skills.length,
    skillFilesChecked,
    agentsMdMatched,
    mismatches,
  };
}

/** True when `dir` already contains any synced files. */
export async function hasExistingSourceFiles(dir: string): Promise<boolean> {
  const walked = await walkSyncTree(dir);
  return Object.keys(walked.manifest).length > 0;
}

/** True when `markerPath` exists on disk. */
export async function hasMigrationMarker(markerPath: string): Promise<boolean> {
  try {
    await lstat(markerPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs a dry-run or live migration of `data` into `targetDir`.
 * Refuses to overwrite non-empty `targetDir` unless `force` is true.
 */
export async function runMigration(args: {
  data: LegacyData;
  targetDir: string;
  tmpDir: string;
  markerPath?: string;
  apply: boolean;
  force?: boolean;
}): Promise<MigrationReport> {
  const { data, targetDir, tmpDir, markerPath, apply, force = false } = args;
  const plan = planMigration(data);
  const totalBytes = plan.files.reduce((sum, f) => sum + f.bytes.length, 0);
  const summaryPlan: MigrationReport["plan"] = {
    docs: plan.docs,
    rules: plan.rules,
    skills: plan.skills,
    skippedDeleted: plan.skippedDeleted,
    expectedAgentsMdSha256: plan.expectedAgentsMdSha256,
    errors: plan.errors,
    fileCount: plan.files.length,
    totalBytes,
  };

  if (!apply) {
    const verification = await verifyMigration(data, plan, null);
    return { dryRun: true, applied: false, targetDir, plan: summaryPlan, verification };
  }

  if (plan.errors.length > 0) {
    throw new Error(`Migration plan has errors; nothing written:\n${plan.errors.join("\n")}`);
  }
  if (!force && (await hasExistingSourceFiles(targetDir))) {
    throw new Error(
      `Target source folder ${targetDir} already contains files; pass --force to overwrite.`,
    );
  }

  await ensureSourceFolders(targetDir);
  for (const file of plan.files) {
    await writeSyncFileAtomic(targetDir, tmpDir, file.relPath, file.bytes, file.executable);
  }

  const verification = await verifyMigration(data, plan, targetDir);
  if (!verification.ok) {
    throw new Error(
      `Migration verification failed after writing:\n${verification.mismatches.join("\n")}`,
    );
  }

  if (markerPath) {
    await mkdir(dirname(markerPath), { recursive: true });
    const marker = {
      version: 1,
      migratedAt: new Date().toISOString(),
      docs: plan.docs.length,
      rules: plan.rules.length,
      skills: plan.skills.length,
      files: plan.files.length,
      expectedAgentsMdSha256: plan.expectedAgentsMdSha256,
    };
    const staged = join(tmpDir, `.migration-marker-${Date.now()}.tmp`);
    await mkdir(tmpDir, { recursive: true });
    await writeFile(staged, `${JSON.stringify(marker, null, 2)}\n`);
    await rename(staged, markerPath);
  }

  return { dryRun: false, applied: true, targetDir, plan: summaryPlan, verification };
}

/** Human-readable migration diff & verification report. */
export function formatMigrationReport(report: MigrationReport): string {
  const { plan, verification } = report;
  const lines = [
    `Mode: ${report.dryRun ? "dry-run (no files written)" : "applied"}`,
    `Target: ${report.targetDir}`,
    `Global docs: ${plan.docs.length}`,
    ...plan.docs.map(
      (d) =>
        `  + ${d.relPath}  (from ${d.legacyId}, name=${JSON.stringify(d.name)}, ${d.enabled ? "on" : "off"})`,
    ),
    `Scoped rules: ${plan.rules.length}`,
    ...plan.rules.map(
      (r) => `  + ${r.relPath}  (name=${JSON.stringify(r.name)}, ${r.enabled ? "on" : "off"})`,
    ),
    `Skills: ${plan.skills.length} (${verification.skillFilesChecked} files, ${(plan.totalBytes / 1024).toFixed(1)} KiB total)`,
    ...plan.skills.map(
      (s) =>
        `  + skills/${s.name}/  (${s.fileCount} files, treeSha=${s.treeSha.slice(0, 12)}, ${s.enabled ? "on" : "off"})`,
    ),
    `Deleted tombstones skipped (not resurrected): ${plan.skippedDeleted.length}`,
    `AGENTS.md sha256: ${plan.expectedAgentsMdSha256 ?? "(none)"} (${verification.agentsMdMatched ? "MATCH" : "MISMATCH"})`,
    `Verification: ${verification.ok ? "PASS — 0 mismatches (100% lossless)" : `FAIL — ${verification.mismatches.length} mismatch(es)`}`,
    ...plan.errors.map((e) => `  ERROR: ${e}`),
    ...verification.mismatches.map((m) => `  MISMATCH: ${m}`),
  ];
  if (report.dryRun) lines.push("Dry run: pass --apply to export files.");
  return `${lines.join("\n")}\n`;
}

/** Opens a SQLite database file read-only, supporting both Bun and Node runtimes. */
export async function openReadOnlySqlite(dbPath: string): Promise<{
  db: ReadOnlySqlite;
  close(): void;
}> {
  if ("Bun" in globalThis) {
    const bunSqlite = "bun:sqlite";
    const mod = (await import(bunSqlite)) as {
      Database: new (
        path: string,
        opts: { readonly: boolean },
      ) => {
        query(sql: string): { all(...p: unknown[]): unknown[]; get(...p: unknown[]): unknown };
        close(): void;
      };
    };
    const instance = new mod.Database(dbPath, { readonly: true });
    return {
      db: { prepare: (sql) => instance.query(sql) },
      close: () => instance.close(),
    };
  }
  const mod = (await import("better-sqlite3")) as {
    default: new (path: string, opts: { readonly: boolean }) => ReadOnlySqlite & { close(): void };
  };
  const instance = new mod.default(dbPath, { readonly: true });
  return { db: instance, close: () => instance.close() };
}

/** Helper to read legacy rules JSON from a file path for offline CLI dry-runs. */
export async function readLegacyRulesFile(path: string): Promise<Rule[]> {
  const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  return parseLegacyRules(raw);
}

/** Counts entries under `dir`, returning 0 when missing. */
export async function countEntries(dir: string): Promise<number> {
  try {
    return (await readdir(dir)).length;
  } catch {
    return 0;
  }
}
