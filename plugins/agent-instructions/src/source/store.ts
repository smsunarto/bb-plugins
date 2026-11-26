import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { randomBytes } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { lstat, mkdir, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { CatalogChange, CatalogListing, ChangeResult } from "../catalog/contract.ts";
import { checkSkillTree, editableText, linksInto, pathError } from "../catalog/edit-rules.ts";
import {
  MAX_DESCRIPTION_LENGTH,
  parseFrontmatter,
  SKILL_NAME_PATTERN,
} from "../catalog/skill-rules.ts";
import { treeSha } from "../catalog/tree.ts";
import { compose, rulesSchema, type Rule, type RulesState, type Session } from "../shared/rules.ts";
import {
  deleteSyncFileAndPrune,
  ensureSourceFolders,
  isIgnoredEntryName,
  readSyncFile,
  sameManifest,
  sha256Bytes,
  walkSyncTree,
  writeSyncFileAtomic,
  type SyncManifest,
} from "../sync/paths.ts";
import {
  compareOrdered,
  ITEM_ID_PATTERN,
  parseDocFile,
  parseRuleFile,
  serializeDocFile,
  serializeRuleFile,
  type ParsedDoc,
} from "./format.ts";
import {
  hasExistingSourceFiles,
  hasMigrationMarker,
  openReadOnlySqlite,
  parseLegacyRules,
  readLegacySqlite,
  runMigration,
  type LegacyData,
} from "./migrate.ts";

export type SourceChangeEvent = {
  reason: "disk" | "local" | "sync";
  /** Host that triggered a sync pull, so the sync manager does not echo back to it. */
  originHostId?: string;
  revision: number;
  rulesRevision: number;
  catalogChanged: boolean;
  rulesChanged: boolean;
};

type LoadedDoc = ParsedDoc & {
  /** SHA-256 of the raw file on disk, used for CAS conflict detection. */
  sha256: string;
  size: number;
};

type LoadedSkillFile = {
  path: string;
  executable: boolean;
  sha256: string;
  bytes: Buffer;
};

type LoadedSkill = {
  name: string;
  description: string;
  enabled: boolean;
  valid: boolean;
  error?: string;
  treeSha: string;
  files: LoadedSkillFile[];
};

type TrashPayload =
  | {
      kind: "doc";
      key: string;
      name: string;
      at: number;
      rawBase64: string;
    }
  | {
      kind: "skill";
      key: string;
      name: string;
      at: number;
      enabled: boolean;
      files: { path: string; executable: boolean; base64: string }[];
    };

export type SourceStore = ReturnType<typeof openSourceStore>;

const REMEMBERED_SESSIONS = 200;
const WATCH_DEBOUNCE_MS = 150;
const LEGACY_KV_KEY = "state";

type Failure = Exclude<ChangeResult, { outcome: "saved" }>;
const invalid = (...errors: string[]): Failure => ({ outcome: "invalid", errors });
const conflict = (message: string): Failure => ({ outcome: "conflict", message });

function trashFileName(kind: "skill" | "doc", key: string): string {
  return `${kind}--${encodeURIComponent(key)}.json`;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Unified file-backed source of truth under `<dataDir>/plugins/<pluginId>/source/`.
 * Replaces SQLite (`data.db`) and KV (`state`) as the authoritative store for
 * global docs (`instructions/*.md`), scoped rules (`rules/*.md`), and skills (`skills/<name>/...`).
 */
export function openSourceStore(bb: BbPluginApi) {
  const pluginDir = join(bb.server.experimental_dataDir, "plugins", bb.pluginId);
  const sourceDir = join(pluginDir, "source");
  const trashDir = join(pluginDir, "trash");
  const tmpDir = join(pluginDir, ".tmp");
  const markerPath = join(pluginDir, "migration.json");
  const legacyDbPath = join(pluginDir, "data.db");

  let revision = 0;
  let rulesRevision = 0;
  let manifest: SyncManifest = {};
  let docs: LoadedDoc[] = [];
  let skills: LoadedSkill[] = [];
  let rules: Rule[] = [];
  let conflicts: string[] = [];
  let deleted: TrashPayload[] = [];

  const sessions = new Map<string, Session>();
  const listeners = new Set<(event: SourceChangeEvent) => void>();

  let watcher: FSWatcher | null = null;
  let watchTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  // Serialize all disk reads/writes and reloads through one queue.
  let queue: Promise<unknown> = Promise.resolve();
  function withLock<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task);
    queue = run.catch(() => undefined);
    return run;
  }

  function emit(event: SourceChangeEvent): void {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        bb.log.warn(
          `source change listener failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  async function readTrash(): Promise<TrashPayload[]> {
    let entries: string[];
    try {
      entries = await readdir(trashDir);
    } catch {
      return [];
    }
    const items: TrashPayload[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(await readFile(join(trashDir, entry), "utf8")) as TrashPayload;
        if (parsed && (parsed.kind === "doc" || parsed.kind === "skill") && parsed.key)
          items.push(parsed);
      } catch {
        // Ignore corrupt trash entry.
      }
    }
    items.sort((a, b) => b.at - a.at);
    return items;
  }

  async function writeTrash(payload: TrashPayload): Promise<void> {
    await mkdir(trashDir, { recursive: true });
    await mkdir(tmpDir, { recursive: true });
    const staged = join(tmpDir, `.trash-${randomBytes(6).toString("hex")}`);
    await writeFile(staged, `${JSON.stringify(payload)}\n`);
    await rename(staged, join(trashDir, trashFileName(payload.kind, payload.key)));
  }

  async function removeTrash(kind: "skill" | "doc", key: string): Promise<void> {
    await unlink(join(trashDir, trashFileName(kind, key))).catch(() => undefined);
  }

  /**
   * Scans `sourceDir` and `trashDir` into memory.
   * Returns what changed relative to the previous in-memory snapshot.
   */
  async function reloadFromDiskUnlocked(
    reason: SourceChangeEvent["reason"],
    originHostId?: string,
  ): Promise<{ changed: boolean; catalogChanged: boolean; rulesChanged: boolean }> {
    const walked = await walkSyncTree(sourceDir);
    if (walked.symlinks.length > 0)
      bb.log.warn(`source: skipped symlinks: ${walked.symlinks.slice(0, 10).join(", ")}`);
    if (walked.tooLarge.length > 0)
      bb.log.warn(`source: skipped oversized files: ${walked.tooLarge.slice(0, 10).join(", ")}`);
    if (walked.truncated) bb.log.warn(`source: file count cap reached; some files were skipped`);

    const nextTrash = await readTrash();
    const trashChanged =
      nextTrash.length !== deleted.length ||
      nextTrash.some(
        (t, i) =>
          t.kind !== deleted[i]?.kind || t.key !== deleted[i]?.key || t.at !== deleted[i]?.at,
      );

    if (sameManifest(walked.manifest, manifest) && !trashChanged) {
      return { changed: false, catalogChanged: false, rulesChanged: false };
    }

    const nextDocs: LoadedDoc[] = [];
    const nextRulesWithOrder: { id: string; order: number | undefined; rule: Rule }[] = [];
    const skillFilesByName = new Map<string, LoadedSkillFile[]>();
    const disabledSkills = new Set<string>();
    const nextConflicts: string[] = [];

    const paths = Object.keys(walked.manifest).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    for (const relPath of paths) {
      const segments = relPath.split("/");
      const root = segments[0]!;
      if (root === "conflicts") {
        nextConflicts.push(relPath);
        continue;
      }
      if (root === "instructions") {
        if (segments.length !== 2 || !segments[1]!.endsWith(".md")) continue;
        const id = segments[1]!.slice(0, -3);
        if (!ITEM_ID_PATTERN.test(id)) {
          bb.log.warn(`source: ignoring doc with unsupported filename ${relPath}`);
          continue;
        }
        const file = await readSyncFile(sourceDir, relPath);
        if (!file) continue;
        const text = editableText(file.bytes);
        if (text === null) {
          bb.log.warn(`source: ignoring non-UTF8 doc ${relPath}`);
          continue;
        }
        const parsed = parseDocFile(id, text);
        nextDocs.push({ ...parsed, sha256: file.sha256, size: file.bytes.length });
        continue;
      }
      if (root === "rules") {
        if (segments.length !== 2 || !segments[1]!.endsWith(".md")) continue;
        const id = segments[1]!.slice(0, -3);
        const file = await readSyncFile(sourceDir, relPath);
        if (!file) continue;
        const text = editableText(file.bytes);
        if (text === null) {
          bb.log.warn(`source: ignoring non-UTF8 rule ${relPath}`);
          continue;
        }
        const parsed = parseRuleFile(id, text);
        if ("error" in parsed) {
          bb.log.warn(`source: skipping invalid rule ${relPath}: ${parsed.error}`);
          continue;
        }
        nextRulesWithOrder.push({ id, order: parsed.order, rule: parsed.rule });
        continue;
      }
      if (root === "skills") {
        if (segments.length < 3) continue;
        const skillName = segments[1]!;
        const innerPath = segments.slice(2).join("/");
        if (innerPath === ".disabled") {
          disabledSkills.add(skillName);
          continue;
        }
        const file = await readSyncFile(sourceDir, relPath);
        if (!file) continue;
        const list = skillFilesByName.get(skillName) ?? [];
        list.push({
          path: innerPath,
          executable: file.executable,
          sha256: file.sha256,
          bytes: file.bytes,
        });
        skillFilesByName.set(skillName, list);
      }
    }

    nextDocs.sort(compareOrdered);
    nextRulesWithOrder.sort(compareOrdered);
    const nextRules = nextRulesWithOrder.map((r) => r.rule);

    const nextSkills: LoadedSkill[] = [];
    for (const [name, files] of [...skillFilesByName.entries()].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )) {
      files.sort((a, b) =>
        a.path === "SKILL.md" ? -1 : b.path === "SKILL.md" ? 1 : a.path < b.path ? -1 : 1,
      );
      const skillFile = files.find((f) => f.path === "SKILL.md");
      const text = skillFile ? editableText(skillFile.bytes) : null;
      let description = "";
      let valid = false;
      let error: string | undefined;
      if (!SKILL_NAME_PATTERN.test(name)) {
        error = `${JSON.stringify(name)} is not a valid bb skill name`;
      } else if (text === null) {
        error = "Missing or non-UTF8 SKILL.md";
      } else {
        const fm = parseFrontmatter(text);
        if ("error" in fm) {
          error = `SKILL.md: ${fm.error}`;
        } else if (fm.name !== name) {
          error = `SKILL.md declares name ${fm.name}; expected ${name}`;
        } else {
          description = fm.description;
          valid = true;
        }
      }
      if (error) bb.log.warn(`source: skill ${name} not publishable: ${error}`);
      nextSkills.push({
        name,
        description,
        enabled: !disabledSkills.has(name),
        valid,
        ...(error ? { error } : {}),
        treeSha: treeSha(files),
        files,
      });
    }

    const rulesChanged = JSON.stringify(nextRules) !== JSON.stringify(rules);
    const catalogChanged =
      trashChanged ||
      JSON.stringify(nextConflicts) !== JSON.stringify(conflicts) ||
      nextDocs.length !== docs.length ||
      nextDocs.some(
        (d, i) =>
          d.id !== docs[i]?.id ||
          d.name !== docs[i]?.name ||
          d.enabled !== docs[i]?.enabled ||
          d.sha256 !== docs[i]?.sha256,
      ) ||
      nextSkills.length !== skills.length ||
      nextSkills.some(
        (s, i) =>
          s.name !== skills[i]?.name ||
          s.enabled !== skills[i]?.enabled ||
          s.treeSha !== skills[i]?.treeSha ||
          s.description !== skills[i]?.description,
      );

    manifest = walked.manifest;
    docs = nextDocs;
    skills = nextSkills;
    rules = nextRules;
    conflicts = nextConflicts;
    deleted = nextTrash;

    // Only bump revisions after initial boot load, or whenever data changed from empty/prior state.
    if (catalogChanged || rulesChanged) {
      if (catalogChanged) revision++;
      if (rulesChanged) rulesRevision++;
      if (reason !== "local" || revision > 0 || rulesRevision > 0) {
        // Callers of `local` mutations emit after finishing; disk & sync emit here.
        if (reason !== "local") {
          emit({ reason, originHostId, revision, rulesRevision, catalogChanged, rulesChanged });
        }
      }
    }
    return { changed: catalogChanged || rulesChanged, catalogChanged, rulesChanged };
  }

  /** Reads legacy SQLite + KV data for one-time migration (read-only). */
  async function readLegacyData(): Promise<LegacyData> {
    let sqliteData: Omit<LegacyData, "rules"> = { docs: [], skills: [], deleted: [] };
    if (await fileExists(legacyDbPath)) {
      const opened = await openReadOnlySqlite(legacyDbPath);
      try {
        sqliteData = readLegacySqlite(opened.db);
      } finally {
        opened.close();
      }
    }
    const rawKv = await bb.storage.kv.get(LEGACY_KV_KEY);
    const legacyRules = rawKv ? parseLegacyRules(rawKv) : [];
    return { ...sqliteData, rules: legacyRules };
  }

  async function maybeAutoMigrate(): Promise<void> {
    if (await hasMigrationMarker(markerPath)) return;
    if (await hasExistingSourceFiles(sourceDir)) return;
    const legacy = await readLegacyData();
    if (legacy.docs.length === 0 && legacy.skills.length === 0 && legacy.rules.length === 0) return;
    const report = await runMigration({
      data: legacy,
      targetDir: sourceDir,
      tmpDir,
      markerPath,
      apply: true,
    });
    bb.log.info(
      `migrated legacy catalog to ${sourceDir}: ${report.plan.docs.length} docs, ${report.plan.rules.length} rules, ${report.plan.skills.length} skills (${report.verification.skillFilesChecked} files)`,
    );
  }

  /** Writes `nextRules` to `source/rules/*.md` and removes deleted rule files. */
  async function writeRulesUnlocked(nextRules: Rule[]): Promise<void> {
    const validated = rulesSchema.parse(nextRules);
    for (const rule of validated) {
      if (!ITEM_ID_PATTERN.test(rule.id))
        throw new Error(`Invalid rule id ${JSON.stringify(rule.id)}`);
    }
    await ensureSourceFolders(sourceDir);
    const wanted = new Set(validated.map((r) => `rules/${r.id}.md`));
    const existing = Object.keys(manifest).filter(
      (p) => p.startsWith("rules/") && p.endsWith(".md") && p.split("/").length === 2,
    );
    for (const oldPath of existing) {
      if (!wanted.has(oldPath)) await deleteSyncFileAndPrune(sourceDir, oldPath);
    }
    for (let i = 0; i < validated.length; i++) {
      const rule = validated[i]!;
      const relPath = `rules/${rule.id}.md`;
      const serialized = serializeRuleFile(rule, i);
      const bytes = Buffer.from(serialized, "utf8");
      const sha = sha256Bytes(bytes);
      if (manifest[relPath]?.sha256 === sha) continue;
      await writeSyncFileAtomic(sourceDir, tmpDir, relPath, bytes, false);
    }
  }

  function enabledSkillNames(): Set<string> {
    return new Set(skills.filter((s) => s.enabled && s.valid).map((s) => s.name));
  }

  function incomingLinks(target: string): string[] {
    const others = skills
      .filter((s) => s.enabled && s.valid)
      .map((s) => ({ name: s.name, files: s.files }));
    return linksInto(target, others).map(
      (file) => `${file} links into ${target}, which agents will no longer find`,
    );
  }

  async function applyCatalogChangeUnlocked(change: CatalogChange): Promise<ChangeResult> {
    // Always refresh from disk first so external edits are caught as conflicts before writing.
    const priorSync = await reloadFromDiskUnlocked("disk");
    if (priorSync.changed) {
      // Reload already emitted to listeners; proceed with fresh state for CAS checks.
    }

    await ensureSourceFolders(sourceDir);

    switch (change.op) {
      case "saveFile": {
        const skill = skills.find((s) => s.name === change.skill);
        if (!skill) return conflict(`${change.skill} no longer exists`);
        const err = pathError(change.path);
        if (err) return invalid(err);
        const current = skill.files.find((f) => f.path === change.path);
        if ((current?.sha256 ?? null) !== change.expectedSha256) {
          return conflict(
            current ? `${change.path} changed since you opened it` : `${change.path} was deleted`,
          );
        }
        if (current && editableText(current.bytes) === null)
          return invalid(`${change.path} is not a text file, so it cannot be edited here`);
        const bytes = Buffer.from(change.content, "utf8");
        const executable = (current?.executable ?? false) || change.content.startsWith("#!");
        const nextFile: LoadedSkillFile = {
          path: change.path,
          executable,
          sha256: sha256Bytes(bytes),
          bytes,
        };
        const nextFiles = current
          ? skill.files.map((f) => (f.path === change.path ? nextFile : f))
          : [...skill.files, nextFile];
        const check = checkSkillTree(
          skill.name,
          nextFiles,
          new Set([change.path]),
          enabledSkillNames(),
        );
        if (check.errors.length > 0) return invalid(...check.errors);
        await writeSyncFileAtomic(
          sourceDir,
          tmpDir,
          `skills/${skill.name}/${change.path}`,
          bytes,
          executable,
        );
        const reloaded = await reloadFromDiskUnlocked("local");
        const updatedSkill = skills.find((s) => s.name === skill.name);
        emit({
          reason: "local",
          revision,
          rulesRevision,
          catalogChanged: reloaded.catalogChanged || true,
          rulesChanged: reloaded.rulesChanged,
        });
        return {
          outcome: "saved",
          revision,
          sha256: nextFile.sha256,
          treeSha: updatedSkill?.treeSha ?? treeSha(nextFiles),
          warnings: check.warnings,
        };
      }

      case "deleteFile": {
        if (change.path === "SKILL.md")
          return invalid("SKILL.md cannot be deleted; delete the skill");
        const skill = skills.find((s) => s.name === change.skill);
        if (!skill) return conflict(`${change.skill} no longer exists`);
        const current = skill.files.find((f) => f.path === change.path);
        if (!current) return conflict(`${change.path} was already deleted`);
        if (current.sha256 !== change.expectedSha256)
          return conflict(`${change.path} changed since you opened it`);
        const nextFiles = skill.files.filter((f) => f !== current);
        const check = checkSkillTree(skill.name, nextFiles, new Set(), enabledSkillNames());
        if (check.errors.length > 0) return invalid(...check.errors);
        await deleteSyncFileAndPrune(sourceDir, `skills/${skill.name}/${change.path}`);
        const reloaded = await reloadFromDiskUnlocked("local");
        const updatedSkill = skills.find((s) => s.name === skill.name);
        emit({
          reason: "local",
          revision,
          rulesRevision,
          catalogChanged: reloaded.catalogChanged || true,
          rulesChanged: reloaded.rulesChanged,
        });
        return {
          outcome: "saved",
          revision,
          treeSha: updatedSkill?.treeSha ?? treeSha(nextFiles),
          warnings: check.warnings,
        };
      }

      case "createSkill": {
        const name = change.name.trim();
        const description = change.description.trim();
        if (!SKILL_NAME_PATTERN.test(name)) {
          return invalid(
            `${JSON.stringify(name)} is not a valid skill name: lowercase letters, digits and single hyphens, up to 64`,
          );
        }
        if (description.length === 0 || description.length > MAX_DESCRIPTION_LENGTH)
          return invalid(`The description must be 1-${MAX_DESCRIPTION_LENGTH} characters`);
        if (skills.some((s) => s.name.toLowerCase() === name.toLowerCase()))
          return invalid(`A skill named ${name} already exists`);
        if (deleted.some((d) => d.kind === "skill" && d.key === name))
          return invalid(`${name} is in Recently deleted; restore it there, or remove it first`);
        const text = `---\n${stringifyYaml({ name, description }, { lineWidth: 0 })}---\n\n# ${name}\n`;
        const bytes = Buffer.from(text, "utf8");
        const sha = sha256Bytes(bytes);
        const files = [{ path: "SKILL.md", executable: false, sha256: sha, bytes }];
        const check = checkSkillTree(name, files, new Set(["SKILL.md"]), enabledSkillNames());
        if (check.errors.length > 0) return invalid(...check.errors);
        await writeSyncFileAtomic(sourceDir, tmpDir, `skills/${name}/SKILL.md`, bytes, false);
        const reloaded = await reloadFromDiskUnlocked("local");
        const created = skills.find((s) => s.name === name);
        emit({
          reason: "local",
          revision,
          rulesRevision,
          catalogChanged: reloaded.catalogChanged || true,
          rulesChanged: reloaded.rulesChanged,
        });
        return {
          outcome: "saved",
          revision,
          sha256: sha,
          treeSha: created?.treeSha ?? treeSha(files),
          warnings: check.warnings,
        };
      }

      case "deleteSkill": {
        const skill = skills.find((s) => s.name === change.name);
        if (!skill) return conflict(`${change.name} was already deleted`);
        if (skill.treeSha !== change.expectedTreeSha)
          return conflict(`${change.name} changed since you opened it; review it before deleting`);
        const warnings = incomingLinks(skill.name);
        await writeTrash({
          kind: "skill",
          key: skill.name,
          name: skill.name,
          at: Date.now(),
          enabled: skill.enabled,
          files: skill.files.map((f) => ({
            path: f.path,
            executable: f.executable,
            base64: f.bytes.toString("base64"),
          })),
        });
        // Remove every synced file in the skill folder (including .disabled).
        for (const f of skill.files) {
          await deleteSyncFileAndPrune(sourceDir, `skills/${skill.name}/${f.path}`);
        }
        await deleteSyncFileAndPrune(sourceDir, `skills/${skill.name}/.disabled`);
        await rm(join(sourceDir, "skills", skill.name), { recursive: true, force: true }).catch(
          () => undefined,
        );
        const reloaded = await reloadFromDiskUnlocked("local");
        emit({
          reason: "local",
          revision,
          rulesRevision,
          catalogChanged: reloaded.catalogChanged || true,
          rulesChanged: reloaded.rulesChanged,
        });
        return { outcome: "saved", revision, warnings };
      }

      case "setSkillEnabled": {
        const skill = skills.find((s) => s.name === change.name);
        if (!skill) return conflict(`${change.name} no longer exists`);
        const warnings = change.enabled ? [] : incomingLinks(skill.name);
        const marker = `skills/${skill.name}/.disabled`;
        if (change.enabled) await deleteSyncFileAndPrune(sourceDir, marker);
        else await writeSyncFileAtomic(sourceDir, tmpDir, marker, new Uint8Array(), false);
        const reloaded = await reloadFromDiskUnlocked("local");
        emit({
          reason: "local",
          revision,
          rulesRevision,
          catalogChanged: reloaded.catalogChanged || true,
          rulesChanged: reloaded.rulesChanged,
        });
        return { outcome: "saved", revision, warnings };
      }

      case "createDoc": {
        const id = `doc_${randomBytes(6).toString("hex")}`;
        const nextOrder = docs.reduce((max, d) => Math.max(max, d.order ?? -1), -1) + 1;
        const serialized = serializeDocFile({
          id,
          name: change.name,
          enabled: true,
          order: nextOrder,
          body: "",
          hasFrontmatter: true,
        });
        const bytes = Buffer.from(serialized, "utf8");
        await writeSyncFileAtomic(sourceDir, tmpDir, `instructions/${id}.md`, bytes, false);
        const reloaded = await reloadFromDiskUnlocked("local");
        emit({
          reason: "local",
          revision,
          rulesRevision,
          catalogChanged: reloaded.catalogChanged || true,
          rulesChanged: reloaded.rulesChanged,
        });
        return { outcome: "saved", revision, id, sha256: sha256Bytes(bytes), warnings: [] };
      }

      case "saveDoc":
      case "renameDoc":
      case "setDocEnabled":
      case "deleteDoc": {
        const doc = docs.find((d) => d.id === change.id);
        if (!doc) return conflict("This document no longer exists");
        if ("expectedSha256" in change && doc.sha256 !== change.expectedSha256)
          return conflict(`${doc.name} changed since you opened it`);
        const relPath = `instructions/${doc.id}.md`;
        if (change.op === "deleteDoc") {
          const raw = await readSyncFile(sourceDir, relPath);
          if (!raw) return conflict("This document no longer exists");
          await writeTrash({
            kind: "doc",
            key: doc.id,
            name: doc.name,
            at: Date.now(),
            rawBase64: raw.bytes.toString("base64"),
          });
          await deleteSyncFileAndPrune(sourceDir, relPath);
          const reloaded = await reloadFromDiskUnlocked("local");
          emit({
            reason: "local",
            revision,
            rulesRevision,
            catalogChanged: reloaded.catalogChanged || true,
            rulesChanged: reloaded.rulesChanged,
          });
          return { outcome: "saved", revision, warnings: [] };
        }
        const nextDoc =
          change.op === "saveDoc"
            ? { ...doc, body: change.body }
            : change.op === "renameDoc"
              ? { ...doc, name: change.name, hasFrontmatter: true }
              : { ...doc, enabled: change.enabled, hasFrontmatter: true };
        const serialized = serializeDocFile(nextDoc);
        const bytes = Buffer.from(serialized, "utf8");
        await writeSyncFileAtomic(sourceDir, tmpDir, relPath, bytes, false);
        const reloaded = await reloadFromDiskUnlocked("local");
        emit({
          reason: "local",
          revision,
          rulesRevision,
          catalogChanged: reloaded.catalogChanged || true,
          rulesChanged: reloaded.rulesChanged,
        });
        return {
          outcome: "saved",
          revision,
          ...(change.op === "saveDoc" ? { sha256: sha256Bytes(bytes) } : {}),
          warnings: [],
        };
      }

      case "restore":
      case "forget": {
        const entry = deleted.find((d) => d.kind === change.kind && d.key === change.key);
        if (!entry) return conflict("It is no longer in Recently deleted");
        if (change.op === "restore") {
          const taken =
            change.kind === "skill"
              ? skills.some((s) => s.name.toLowerCase() === change.key.toLowerCase())
              : docs.some((d) => d.id.toLowerCase() === change.key.toLowerCase());
          if (taken)
            return invalid(`Something named ${change.key} exists now; rename or delete it first`);
          if (entry.kind === "doc") {
            const bytes = Buffer.from(entry.rawBase64, "base64");
            await writeSyncFileAtomic(
              sourceDir,
              tmpDir,
              `instructions/${entry.key}.md`,
              bytes,
              false,
            );
          } else {
            for (const f of entry.files) {
              const bytes = Buffer.from(f.base64, "base64");
              await writeSyncFileAtomic(
                sourceDir,
                tmpDir,
                `skills/${entry.key}/${f.path}`,
                bytes,
                f.executable,
              );
            }
            if (!entry.enabled) {
              await writeSyncFileAtomic(
                sourceDir,
                tmpDir,
                `skills/${entry.key}/.disabled`,
                new Uint8Array(),
                false,
              );
            }
          }
        }
        await removeTrash(change.kind, change.key);
        const reloaded = await reloadFromDiskUnlocked("local");
        const restoredSkill =
          change.op === "restore" && change.kind === "skill"
            ? skills.find((s) => s.name === change.key)
            : undefined;
        emit({
          reason: "local",
          revision,
          rulesRevision,
          catalogChanged: reloaded.catalogChanged || true,
          rulesChanged: reloaded.rulesChanged,
        });
        return {
          outcome: "saved",
          revision,
          ...(restoredSkill ? { treeSha: restoredSkill.treeSha } : {}),
          warnings: [],
        };
      }
    }
  }

  function scheduleWatchReload(): void {
    if (disposed) return;
    if (watchTimer) clearTimeout(watchTimer);
    watchTimer = setTimeout(() => {
      watchTimer = null;
      if (disposed) return;
      void withLock(() => reloadFromDiskUnlocked("disk")).catch((error) => {
        bb.log.warn(
          `source watch reload failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, WATCH_DEBOUNCE_MS);
  }

  return {
    sourceDir,
    tmpDir,
    pluginDir,
    markerPath,
    legacyDbPath,

    /** Loads the source folder (auto-migrating once if legacy data exists and source is empty). */
    async load(): Promise<void> {
      await withLock(async () => {
        await ensureSourceFolders(sourceDir);
        await maybeAutoMigrate();
        await reloadFromDiskUnlocked("local");
      });
    },

    /** Starts watching `sourceDir` for external edits made by agents or users. */
    startWatch(): void {
      if (watcher || disposed) return;
      try {
        watcher = watch(sourceDir, { recursive: true }, (_eventType, filename) => {
          if (typeof filename === "string") {
            const parts = filename.split(/[\\/]/);
            if (parts.some((p) => p && isIgnoredEntryName(p))) return;
          }
          scheduleWatchReload();
        });
        watcher.on("error", (error) => {
          bb.log.warn(`source watcher error: ${error.message}`);
        });
      } catch (error) {
        bb.log.warn(
          `could not start source folder watch: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },

    dispose(): void {
      disposed = true;
      if (watchTimer) {
        clearTimeout(watchTimer);
        watchTimer = null;
      }
      watcher?.close();
      watcher = null;
      listeners.clear();
    },

    onChange(listener: (event: SourceChangeEvent) => void): () => void {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    /** Serializes an external operation (such as mirror sync) with store mutations. */
    withLock,

    /** Forces a reload from disk (inside the lock). */
    reloadFromDisk(
      reason: SourceChangeEvent["reason"] = "disk",
      originHostId?: string,
    ): Promise<{ changed: boolean; catalogChanged: boolean; rulesChanged: boolean }> {
      return withLock(() => reloadFromDiskUnlocked(reason, originHostId));
    },

    /** Reloads from disk when caller already holds `withLock`. */
    reloadUnlocked: reloadFromDiskUnlocked,

    /** Current in-memory synced manifest snapshot. */
    manifest: (): SyncManifest => ({ ...manifest }),

    /** Reads legacy SQLite + KV data (read-only) for `migrate` CLI. */
    readLegacyData,

    // --- PublishSource contract ---
    publishable(): { name: string; treeSha: string }[] {
      return skills
        .filter((s) => s.enabled && s.valid)
        .map((s) => ({ name: s.name, treeSha: s.treeSha }));
    },

    skillFiles(name: string): { path: string; executable: boolean; bytes: Uint8Array }[] {
      const found = skills.find((s) => s.name === name);
      if (!found) return [];
      return found.files.map((f) => ({
        path: f.path,
        executable: f.executable,
        bytes: f.bytes,
      }));
    },

    docs() {
      return docs.map((d) => ({
        id: d.id,
        name: d.name,
        body: d.body,
        enabled: d.enabled,
        sha256: d.sha256,
      }));
    },

    // --- Catalog reads & writes ---
    revision: () => revision,

    skills() {
      return skills.map((s) => ({
        name: s.name,
        description: s.description,
        enabled: s.enabled,
        valid: s.valid,
        ...(s.error ? { error: s.error } : {}),
        files: s.files.length,
        bytes: s.files.reduce((sum, f) => sum + f.bytes.length, 0),
        treeSha: s.treeSha,
      }));
    },

    conflicts: () => [...conflicts],

    listing(): Omit<CatalogListing, "published"> {
      return {
        revision,
        sourcePath: sourceDir,
        conflicts: [...conflicts],
        docs: docs.map((d) => ({
          id: d.id,
          name: d.name,
          enabled: d.enabled,
          characters: d.body.length,
          sha256: d.sha256,
        })),
        skills: skills.map((s) => ({
          name: s.name,
          description: s.description,
          enabled: s.enabled,
          treeSha: s.treeSha,
          files: s.files.map((f) => ({
            path: f.path,
            executable: f.executable,
            size: f.bytes.length,
            text: editableText(f.bytes) !== null,
          })),
        })),
        deleted: deleted.map((d) => ({ kind: d.kind, key: d.key, name: d.name, at: d.at })),
      };
    },

    file(target: { doc: string } | { skill: string; path: string }) {
      if ("doc" in target) {
        const found = docs.find((d) => d.id === target.doc);
        return found
          ? {
              bytes: Buffer.from(found.body, "utf8"),
              sha256: found.sha256,
              executable: false,
            }
          : null;
      }
      const found = skills
        .find((s) => s.name === target.skill)
        ?.files.find((f) => f.path === target.path);
      return found
        ? { bytes: found.bytes, sha256: found.sha256, executable: found.executable }
        : null;
    },

    change(change: CatalogChange): Promise<ChangeResult> {
      return withLock(() => applyCatalogChangeUnlocked(change));
    },

    // --- RuleStore contract ---
    rulesState(): RulesState {
      return { revision: rulesRevision, rules };
    },

    updateRules(change: (current: Rule[]) => Rule[]): Promise<RulesState> {
      return withLock(async () => {
        await reloadFromDiskUnlocked("disk");
        const next = change([...rules]);
        await writeRulesUnlocked(next);
        const reloaded = await reloadFromDiskUnlocked("local");
        emit({
          reason: "local",
          revision,
          rulesRevision,
          catalogChanged: reloaded.catalogChanged,
          rulesChanged: reloaded.rulesChanged || true,
        });
        return { revision: rulesRevision, rules };
      });
    },

    saveRules(
      nextRules: Rule[],
      expectedRevision: number,
    ): Promise<RulesState & { saved: boolean }> {
      return withLock(async () => {
        await reloadFromDiskUnlocked("disk");
        if (expectedRevision !== rulesRevision) {
          return { revision: rulesRevision, rules, saved: false };
        }
        await writeRulesUnlocked(nextRules);
        const reloaded = await reloadFromDiskUnlocked("local");
        emit({
          reason: "local",
          revision,
          rulesRevision,
          catalogChanged: reloaded.catalogChanged,
          rulesChanged: reloaded.rulesChanged || true,
        });
        return { revision: rulesRevision, rules, saved: true };
      });
    },

    resolve(threadId: string, session: Session): string | null {
      sessions.delete(threadId);
      sessions.set(threadId, session);
      if (sessions.size > REMEMBERED_SESSIONS) {
        sessions.delete(sessions.keys().next().value ?? threadId);
      }
      return compose(rules, session);
    },

    lastSession: (threadId: string) => sessions.get(threadId),
  };
}
