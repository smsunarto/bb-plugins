import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { editableText } from "../catalog/edit-rules.ts";
import { globalText } from "../catalog/publish.ts";
import { treeSha } from "../catalog/tree.ts";
import { ruleSchema, type Rule } from "../shared/rules.ts";
import {
  ensureSourceFolders,
  isIgnoredEntryName,
  isSafeSyncPath,
  MAX_SYNC_FILE_BYTES,
  MAX_SYNC_FILES,
  MAX_SYNC_TOTAL_BYTES,
  pathExists,
  readSyncFile,
  sha256Bytes,
  SymlinkRefusedError,
  walkSyncTree,
  writeJsonAtomic,
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

/** Minimal synchronous read-only SQLite interface (works with bun:sqlite and node:sqlite). */
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
  rules: { legacyId: string; id: string; relPath: string; name: string; enabled: boolean }[];
  skills: {
    name: string;
    enabled: boolean;
    fileCount: number;
    treeSha: string;
    expectedTreeSha: string;
    includedPaths: string[];
  }[];
  skippedDeleted: LegacyDeleted[];
  files: PlannedFile[];
  expectedAgentsMdSha256: string | null;
  warnings: string[];
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
  plan: Omit<MigrationPlan, "files"> & {
    fileCount: number;
    totalBytes: number;
    skillBytes: number;
  };
  verification: MigrationVerification;
};

function tableExists(db: ReadOnlySqlite, name: string): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { ok: number } | undefined;
  return row?.ok === 1;
}

/** Allocates a unique case-insensitive stem <= 80 chars matching `ITEM_ID_PATTERN`. */
function allocateUniqueId(raw: string, used: Set<string>, fallback = "doc"): string {
  const base = sanitizeDocId(raw) || fallback;
  let candidate = base;
  if (used.has(candidate.toLowerCase())) {
    let suffix = 2;
    while (true) {
      const tail = `-${suffix}`;
      const next = `${base.slice(0, 80 - tail.length).replace(/-+$/, "") || fallback}${tail}`;
      if (!used.has(next.toLowerCase())) {
        candidate = next;
        break;
      }
      suffix++;
    }
  }
  used.add(candidate.toLowerCase());
  return candidate;
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

/**
 * Legacy KV payloads used exact-case rule id uniqueness; validate with that schema
 * here so case-insensitive collisions reach `planMigration`'s `allocateUniqueId`.
 */
const legacyRulesSchema = z
  .array(ruleSchema)
  .refine(
    (rules) => new Set(rules.map((r) => r.id)).size === rules.length,
    "rule ids must be unique",
  );

const legacyRulesStateSchema = z.object({
  revision: z.number().int().nonnegative(),
  rules: legacyRulesSchema,
});

/** Parses legacy rules from plugin KV `state` (or `{ rules: [...] }` JSON). */
export function parseLegacyRules(
  raw: unknown,
  options: { lenient?: boolean; onWarning?: (message: string) => void } = {},
): Rule[] {
  if (raw === null || raw === undefined) return [];
  const full = legacyRulesStateSchema.safeParse(raw);
  if (full.success) return full.data.rules;
  if (typeof raw === "object" && "rules" in raw) {
    const withDefaultRev = legacyRulesStateSchema.safeParse({
      revision: 0,
      rules: (raw as { rules: unknown }).rules,
    });
    if (withDefaultRev.success) return withDefaultRev.data.rules;
  }
  if (options.lenient) {
    options.onWarning?.("Ignored unreadable legacy rules payload in KV state");
    return [];
  }
  throw new Error("Unreadable legacy rules payload");
}

/**
 * Plans the lossless export of legacy docs, skills, and rules into plain files.
 * Verifies in-memory round-trip parsing of every doc and rule before anything touches disk.
 */
export function planMigration(data: LegacyData): MigrationPlan {
  const errors: string[] = [];
  const warnings: string[] = [];
  const files: PlannedFile[] = [];
  const usedPaths = new Set<string>();
  const usedDocIds = new Set<string>();
  const plannedDocs: MigrationPlan["docs"] = [];
  const plannedRules: MigrationPlan["rules"] = [];
  const plannedSkills: MigrationPlan["skills"] = [];

  const addFile = (relPath: string, bytes: Uint8Array, executable: boolean): boolean => {
    if (!isSafeSyncPath(relPath)) {
      errors.push(`Refused unsafe target path: ${relPath}`);
      return false;
    }
    if (bytes.length > MAX_SYNC_FILE_BYTES) {
      errors.push(`${relPath} exceeds the ${MAX_SYNC_FILE_BYTES}-byte sync limit`);
      return false;
    }
    const lower = relPath.toLowerCase();
    if (usedPaths.has(lower)) {
      errors.push(`Target path collision: ${relPath}`);
      return false;
    }
    usedPaths.add(lower);
    files.push({ relPath, executable, bytes, sha256: sha256Bytes(bytes) });
    return true;
  };

  // 1. Global instruction docs
  data.docs.forEach((doc, index) => {
    const id = allocateUniqueId(doc.id, usedDocIds, "doc");
    if (!ITEM_ID_PATTERN.test(id)) {
      errors.push(`Sanitized doc id ${JSON.stringify(id)} fails ITEM_ID_PATTERN`);
      return;
    }
    const cleanName = doc.name.trim().slice(0, 80).trim() || id;
    if (cleanName !== doc.name) {
      warnings.push(
        `Normalized legacy doc ${JSON.stringify(doc.id)} name from ${JSON.stringify(doc.name)} to ${JSON.stringify(cleanName)}`,
      );
    }
    const relPath = `instructions/${id}.md`;
    const serialized = serializeDocFile({
      id,
      name: cleanName,
      enabled: doc.enabled,
      order: index,
      body: doc.body,
      hasFrontmatter: true,
    });
    const bytes = Buffer.from(serialized, "utf8");
    if (editableText(bytes) === null) {
      errors.push(`Doc ${doc.id} contains non-editable binary/NUL bytes`);
      return;
    }
    const roundTrip = parseDocFile(id, serialized);
    if (
      roundTrip.name !== cleanName ||
      roundTrip.enabled !== doc.enabled ||
      roundTrip.order !== index ||
      roundTrip.body !== doc.body
    ) {
      errors.push(`Doc ${doc.id} failed lossless round-trip check`);
    }
    addFile(relPath, bytes, false);
    plannedDocs.push({ legacyId: doc.id, id, relPath, name: cleanName, enabled: doc.enabled });
  });

  // 2. Scoped rules
  const usedRuleIds = new Set<string>();
  data.rules.forEach((rule, index) => {
    let id = rule.id;
    if (!ITEM_ID_PATTERN.test(id) || usedRuleIds.has(id.toLowerCase())) {
      id = allocateUniqueId(rule.id, usedRuleIds, "rule");
      warnings.push(
        `Normalized legacy rule id ${JSON.stringify(rule.id)} to ${JSON.stringify(id)}`,
      );
    } else {
      usedRuleIds.add(id.toLowerCase());
    }
    const normalizedRule: Rule = id === rule.id ? rule : { ...rule, id };
    const relPath = `rules/${id}.md`;
    const serialized = serializeRuleFile(normalizedRule, index);
    const bytes = Buffer.from(serialized, "utf8");
    if (editableText(bytes) === null) {
      errors.push(`Rule ${rule.id} contains non-editable binary/NUL bytes`);
      return;
    }
    const roundTrip = parseRuleFile(id, serialized);
    if ("error" in roundTrip) {
      errors.push(`Rule ${rule.id} failed round-trip parse: ${roundTrip.error}`);
    } else if (
      JSON.stringify(roundTrip.rule) !== JSON.stringify(normalizedRule) ||
      roundTrip.order !== index
    ) {
      errors.push(`Rule ${rule.id} failed lossless round-trip equality`);
    }
    addFile(relPath, bytes, false);
    plannedRules.push({
      legacyId: rule.id,
      id,
      relPath,
      name: normalizedRule.name,
      enabled: normalizedRule.enabled,
    });
  });

  // 3. Skills (raw bytes preserved verbatim; sync-ignored junk & reserved `.disabled` files skipped with warning)
  for (const skill of data.skills) {
    const includedPaths: string[] = [];
    const includedForHash: { path: string; executable: boolean; sha256: string }[] = [];
    for (const file of skill.files) {
      const segments = file.path.split("/");
      if (file.path === ".disabled" || segments.some(isIgnoredEntryName)) {
        warnings.push(
          `Skipped legacy skill file skills/${skill.name}/${file.path} (ignored or reserved filename)`,
        );
        continue;
      }
      const actualSha = sha256Bytes(file.bytes);
      if (actualSha !== file.sha256) {
        errors.push(`Skill ${skill.name}/${file.path} stored sha256 disagrees with bytes`);
      }
      if (addFile(`skills/${skill.name}/${file.path}`, file.bytes, file.executable)) {
        includedPaths.push(file.path);
        includedForHash.push({
          path: file.path,
          executable: file.executable,
          sha256: actualSha,
        });
      }
    }
    if (!skill.enabled) {
      addFile(`skills/${skill.name}/.disabled`, new Uint8Array(), false);
    }
    plannedSkills.push({
      name: skill.name,
      enabled: skill.enabled,
      fileCount: includedPaths.length,
      treeSha: skill.treeSha,
      expectedTreeSha:
        includedPaths.length === skill.files.length ? skill.treeSha : treeSha(includedForHash),
      includedPaths,
    });
  }

  if (files.length > MAX_SYNC_FILES) {
    errors.push(
      `Migration plan has ${files.length} files, exceeding MAX_SYNC_FILES (${MAX_SYNC_FILES})`,
    );
  }
  const totalBytes = files.reduce((sum, f) => sum + f.bytes.length, 0);
  if (totalBytes > MAX_SYNC_TOTAL_BYTES) {
    errors.push(
      `Migration plan is ${totalBytes} bytes, exceeding MAX_SYNC_TOTAL_BYTES (${MAX_SYNC_TOTAL_BYTES})`,
    );
  }

  const agentsText = globalText(data.docs);
  return {
    docs: plannedDocs,
    rules: plannedRules,
    skills: plannedSkills,
    skippedDeleted: data.deleted,
    files,
    expectedAgentsMdSha256: agentsText === null ? null : sha256Bytes(agentsText),
    warnings,
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
    if (!ITEM_ID_PATTERN.test(planned.id)) {
      mismatches.push(`Doc ${legacy.id} exported id ${planned.id} fails ITEM_ID_PATTERN`);
      continue;
    }
    const entry = await readEntry(planned.relPath);
    if (!entry) {
      mismatches.push(`Missing exported doc file ${planned.relPath}`);
      continue;
    }
    const text = editableText(entry.bytes);
    if (text === null) {
      mismatches.push(`Exported doc ${planned.relPath} is not valid editable UTF-8 text`);
      continue;
    }
    const parsed = parseDocFile(planned.id, text);
    parsedDocs.push({
      id: parsed.id,
      body: parsed.body,
      enabled: parsed.enabled,
      order: parsed.order,
    });
    if (parsed.name !== planned.name)
      mismatches.push(`Doc ${legacy.id} name mismatch: ${parsed.name} !== ${planned.name}`);
    if (parsed.enabled !== legacy.enabled) mismatches.push(`Doc ${legacy.id} enabled mismatch`);
    if (parsed.order !== i)
      mismatches.push(`Doc ${legacy.id} order mismatch: ${parsed.order} !== ${i}`);
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
  for (let i = 0; i < data.rules.length; i++) {
    const legacy = data.rules[i]!;
    const planned = plan.rules[i];
    if (!planned) {
      mismatches.push(`Missing planned rule for ${legacy.id}`);
      continue;
    }
    const entry = await readEntry(planned.relPath);
    if (!entry) {
      mismatches.push(`Missing exported rule file ${planned.relPath}`);
      continue;
    }
    const text = editableText(entry.bytes);
    if (text === null) {
      mismatches.push(`Exported rule ${planned.relPath} is not valid editable UTF-8 text`);
      continue;
    }
    const parsed = parseRuleFile(planned.id, text);
    if ("error" in parsed) {
      mismatches.push(`Rule ${planned.id} parse error: ${parsed.error}`);
      continue;
    }
    parsedRules.push({ id: planned.id, order: parsed.order, rule: parsed.rule });
  }
  parsedRules.sort(compareOrdered);
  if (parsedRules.length !== data.rules.length) {
    mismatches.push(`Rule count mismatch: ${parsedRules.length} !== ${data.rules.length}`);
  } else {
    for (let i = 0; i < data.rules.length; i++) {
      const planned = plan.rules[i]!;
      const expectedRule: Rule =
        planned.id === data.rules[i]!.id ? data.rules[i]! : { ...data.rules[i]!, id: planned.id };
      if (JSON.stringify(parsedRules[i]!.rule) !== JSON.stringify(expectedRule)) {
        mismatches.push(`Rule ${expectedRule.id} at index ${i} differs after export`);
      }
    }
  }

  // Verify skills byte-for-byte
  let skillFilesChecked = 0;
  for (let sIdx = 0; sIdx < data.skills.length; sIdx++) {
    const skill = data.skills[sIdx]!;
    const plannedSkill = plan.skills[sIdx];
    const includedSet = new Set(plannedSkill?.includedPaths ?? skill.files.map((f) => f.path));
    const hashed: { path: string; executable: boolean; sha256: string }[] = [];
    for (const file of skill.files) {
      if (!includedSet.has(file.path)) continue;
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
    const expectedTreeSha = plannedSkill?.expectedTreeSha ?? skill.treeSha;
    if (actualTreeSha !== expectedTreeSha) {
      mismatches.push(
        `Skill ${skill.name} treeSha mismatch: ${actualTreeSha} !== ${expectedTreeSha}`,
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
    if (walked.truncated) mismatches.push("Exported tree hit sync truncation cap");
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
  return pathExists(markerPath);
}

/** Refuses symlinks on a directory path if it already exists. */
async function assertNotSymlink(path: string): Promise<boolean> {
  try {
    const st = await lstat(path);
    if (st.isSymbolicLink()) throw new SymlinkRefusedError(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Runs a dry-run or live migration of `data` into `targetDir`.
 * Stages the entire export into a sibling directory on the target filesystem,
 * verifies every file on disk, and atomically swaps it into `targetDir` before
 * writing `migration.json`. Refuses symlinks and refuses to overwrite non-empty
 * `targetDir` unless `force` is true.
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
  const skillBytes = plan.files
    .filter((f) => f.relPath.startsWith("skills/"))
    .reduce((sum, f) => sum + f.bytes.length, 0);
  const summaryPlan: MigrationReport["plan"] = {
    docs: plan.docs,
    rules: plan.rules,
    skills: plan.skills,
    skippedDeleted: plan.skippedDeleted,
    expectedAgentsMdSha256: plan.expectedAgentsMdSha256,
    warnings: plan.warnings,
    errors: plan.errors,
    fileCount: plan.files.length,
    totalBytes,
    skillBytes,
  };

  if (!apply) {
    const verification = await verifyMigration(data, plan, null);
    return { dryRun: true, applied: false, targetDir, plan: summaryPlan, verification };
  }

  if (plan.errors.length > 0) {
    throw new Error(`Migration plan has errors; nothing written:\n${plan.errors.join("\n")}`);
  }

  const resolvedTarget = resolve(targetDir);
  const targetExists = await assertNotSymlink(resolvedTarget);
  if (markerPath) await assertNotSymlink(resolve(markerPath));

  if (!force && targetExists && (await hasExistingSourceFiles(resolvedTarget))) {
    throw new Error(
      `Target source folder ${targetDir} already contains files; pass --force to overwrite.`,
    );
  }

  // Stage completely in a sibling folder on the SAME filesystem so rename() is atomic and never hits EXDEV.
  const parentDir = dirname(resolvedTarget);
  await mkdir(parentDir, { recursive: true });
  const suffix = randomBytes(6).toString("hex");
  const stageDir = join(parentDir, `.source-migrating-${suffix}`);
  const stageTmpDir = join(parentDir, `.source-migrating-tmp-${suffix}`);

  let verification: MigrationVerification;
  try {
    await ensureSourceFolders(stageDir);
    for (const file of plan.files) {
      await writeSyncFileAtomic(stageDir, stageTmpDir, file.relPath, file.bytes, file.executable);
    }

    verification = await verifyMigration(data, plan, stageDir);
    if (!verification.ok) {
      throw new Error(
        `Migration verification failed before swap:\n${verification.mismatches.join("\n")}`,
      );
    }

    // Atomically swap staged tree into `resolvedTarget`.
    if (targetExists) {
      const backupDir = join(parentDir, `.source-backup-${suffix}`);
      await rename(resolvedTarget, backupDir);
      try {
        await rename(stageDir, resolvedTarget);
      } catch (error) {
        // Restore previous targetDir if the swap failed.
        await rename(backupDir, resolvedTarget).catch(() => undefined);
        throw error;
      }
      await rm(backupDir, { recursive: true, force: true }).catch(() => undefined);
    } else {
      await rename(stageDir, resolvedTarget);
    }
  } finally {
    await rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(stageTmpDir, { recursive: true, force: true }).catch(() => undefined);
  }

  if (markerPath) {
    const marker = {
      version: 1,
      migratedAt: new Date().toISOString(),
      docs: plan.docs.length,
      rules: plan.rules.length,
      skills: plan.skills.length,
      files: plan.files.length,
      expectedAgentsMdSha256: plan.expectedAgentsMdSha256,
    };
    await writeJsonAtomic(markerPath, tmpDir, marker, { pretty: true });
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
    `Skills: ${plan.skills.length} (${verification.skillFilesChecked} files, ${(plan.skillBytes / 1024).toFixed(1)} KiB skills / ${(plan.totalBytes / 1024).toFixed(1)} KiB total)`,
    ...plan.skills.map(
      (s) =>
        `  + skills/${s.name}/  (${s.fileCount} files, treeSha=${s.treeSha.slice(0, 12)}, ${s.enabled ? "on" : "off"})`,
    ),
    `Deleted tombstones skipped (not resurrected): ${plan.skippedDeleted.length}`,
    `AGENTS.md sha256: ${plan.expectedAgentsMdSha256 ?? "(none)"} (${verification.agentsMdMatched ? "MATCH" : "MISMATCH"})`,
    `Verification: ${verification.ok ? "PASS — 0 mismatches (100% lossless)" : `FAIL — ${verification.mismatches.length} mismatch(es)`}`,
    ...plan.warnings.map((w) => `  WARN: ${w}`),
    ...plan.errors.map((e) => `  ERROR: ${e}`),
    ...verification.mismatches.map((m) => `  MISMATCH: ${m}`),
  ];
  if (report.dryRun) lines.push("Dry run: pass --apply to export files.");
  return `${lines.join("\n")}\n`;
}

/** Opens a SQLite database file read-only, supporting both Bun and Node built-in `node:sqlite`. */
export async function openReadOnlySqlite(dbPath: string): Promise<{
  db: ReadOnlySqlite;
  close(): void;
}> {
  const st = await lstat(dbPath);
  if (st.isSymbolicLink()) throw new SymlinkRefusedError(dbPath);
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
  const nodeSqlite = "node:sqlite";
  const mod = (await import(nodeSqlite)) as {
    DatabaseSync: new (
      path: string,
      opts: { readOnly: boolean },
    ) => ReadOnlySqlite & { close(): void };
  };
  const instance = new mod.DatabaseSync(dbPath, { readOnly: true });
  return { db: instance, close: () => instance.close() };
}

/** Helper to read legacy rules JSON from a file path for offline dry-runs/tests. */
export async function readLegacyRulesFile(path: string): Promise<Rule[]> {
  const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  return parseLegacyRules(raw);
}
