import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { randomBytes } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { readdir, readFile, rename, rm, stat, unlink } from "node:fs/promises";
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
  pathExists,
  readSyncFile,
  sameManifest,
  sha256Bytes,
  walkSyncTree,
  writeJsonAtomic,
  writeSyncFileAtomic,
  type SyncManifest,
  type WalkResult,
  type WalkStatCache,
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
  manifestChanged: boolean;
};

type LoadedDoc = ParsedDoc & {
  /** SHA-256 of the raw file on disk, used for CAS conflict detection. */
  sha256: string;
  size: number;
};

/** Metadata-only representation kept in RAM; raw skill bytes are read on demand from disk. */
type LoadedSkillFile = {
  path: string;
  executable: boolean;
  sha256: string;
  size: number;
  text: boolean;
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

type TrashMeta = {
  kind: "doc" | "skill";
  key: string;
  name: string;
  at: number;
  fileName: string;
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

type PersistedRevisions = {
  version: 1;
  rulesRevision: number;
  rulesHash: string;
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
  const revisionsPath = join(pluginDir, "revisions.json");
  const legacyDbPath = join(pluginDir, "data.db");

  let revision = 0;
  let rulesRevision = 0;
  let persistedRulesHash: string | null = null;
  let booted = false;
  let migrationBlockedReason: string | null = null;

  let manifest: SyncManifest = Object.create(null) as SyncManifest;
  let lastWalk: WalkResult = { manifest, symlinks: [], tooLarge: [], truncated: false };
  let docs: LoadedDoc[] = [];
  let skills: LoadedSkill[] = [];
  let rules: Rule[] = [];
  /** Rule IDs that parsed validly on the last load; unparseable rule files are never auto-deleted. */
  let validRuleIds = new Set<string>();
  let conflicts: string[] = [];
  let deleted: TrashMeta[] = [];

  // Incremental reload caches so a 1-file edit only reads and parses that 1 file.
  const statCache: WalkStatCache = new Map();
  const docCache = new Map<string, { sha256: string; doc: LoadedDoc | null }>();
  const ruleCache = new Map<
    string,
    { sha256: string; parsed: { id: string; order: number | undefined; rule: Rule } | null }
  >();
  const skillFileMetaCache = new Map<
    string,
    { sha256: string; executable: boolean; size: number; text: boolean }
  >();
  const skillHeaderCache = new Map<
    string,
    { sha256: string; description: string; valid: boolean; error?: string }
  >();
  let trashDirMtimeMs: number | null = null;
  let trashDirty = true;

  const sessions = new Map<string, Session>();
  const listeners = new Set<(event: SourceChangeEvent) => void>();

  let watcher: FSWatcher | null = null;
  let watchTimer: ReturnType<typeof setTimeout> | null = null;
  let watching = false;
  let diskDirty = true;
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

  async function loadPersistedRevisions(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(revisionsPath, "utf8")) as PersistedRevisions;
      if (
        parsed &&
        parsed.version === 1 &&
        typeof parsed.rulesRevision === "number" &&
        Number.isInteger(parsed.rulesRevision) &&
        parsed.rulesRevision >= 0
      ) {
        rulesRevision = parsed.rulesRevision;
        persistedRulesHash = typeof parsed.rulesHash === "string" ? parsed.rulesHash : null;
      }
    } catch {
      // No persisted revisions yet.
    }
  }

  async function persistRevisions(rulesHash: string): Promise<void> {
    persistedRulesHash = rulesHash;
    const payload: PersistedRevisions = { version: 1, rulesRevision, rulesHash };
    await writeJsonAtomic(revisionsPath, tmpDir, payload).catch((error) => {
      bb.log.warn(
        `failed to persist revisions: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  async function readTrashMeta(): Promise<TrashMeta[]> {
    let dirStat;
    try {
      dirStat = await stat(trashDir);
    } catch {
      trashDirMtimeMs = null;
      trashDirty = false;
      return [];
    }
    if (!trashDirty && trashDirMtimeMs === dirStat.mtimeMs) {
      return deleted;
    }
    let entries: string[];
    try {
      entries = await readdir(trashDir);
    } catch {
      trashDirMtimeMs = null;
      trashDirty = false;
      return [];
    }
    const items: TrashMeta[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(
          await readFile(join(trashDir, entry), "utf8"),
        ) as Partial<TrashPayload>;
        if (
          parsed &&
          (parsed.kind === "doc" || parsed.kind === "skill") &&
          typeof parsed.key === "string" &&
          typeof parsed.name === "string" &&
          typeof parsed.at === "number"
        ) {
          items.push({
            kind: parsed.kind,
            key: parsed.key,
            name: parsed.name,
            at: parsed.at,
            fileName: entry,
          });
        }
      } catch {
        // Ignore corrupt trash entry.
      }
    }
    items.sort((a, b) => b.at - a.at);
    trashDirMtimeMs = dirStat.mtimeMs;
    trashDirty = false;
    return items;
  }

  async function readTrashPayload(entry: TrashMeta): Promise<TrashPayload | null> {
    try {
      const parsed = JSON.parse(
        await readFile(join(trashDir, entry.fileName), "utf8"),
      ) as TrashPayload;
      if (parsed && (parsed.kind === "doc" || parsed.kind === "skill") && parsed.key) return parsed;
    } catch {
      // Corrupt or removed trash file.
    }
    return null;
  }

  async function writeTrash(payload: TrashPayload): Promise<void> {
    await writeJsonAtomic(
      join(trashDir, trashFileName(payload.kind, payload.key)),
      tmpDir,
      payload,
    );
    trashDirty = true;
  }

  async function removeTrash(kind: "skill" | "doc", key: string): Promise<void> {
    await unlink(join(trashDir, trashFileName(kind, key))).catch(() => undefined);
    trashDirty = true;
  }

  async function readSkillFileBuffers(
    skillName: string,
    files: readonly LoadedSkillFile[],
  ): Promise<{ path: string; executable: boolean; sha256: string; bytes: Buffer }[]> {
    const out: { path: string; executable: boolean; sha256: string; bytes: Buffer }[] = [];
    for (const f of files) {
      const read = await readSyncFile(sourceDir, `skills/${skillName}/${f.path}`);
      if (!read) continue;
      out.push({
        path: f.path,
        executable: read.executable,
        sha256: read.sha256,
        bytes: read.bytes,
      });
    }
    return out;
  }

  /**
   * Incrementally scans `sourceDir` and trash metadata into memory.
   * Unchanged files reuse their cached digest & parsed metadata without re-reading disk.
   */
  async function reloadFromDiskUnlocked(
    reason: SourceChangeEvent["reason"],
    originHostId?: string,
  ): Promise<{
    changed: boolean;
    catalogChanged: boolean;
    rulesChanged: boolean;
    manifestChanged: boolean;
  }> {
    const walked = await walkSyncTree(sourceDir, { statCache });
    lastWalk = walked;
    if (walked.symlinks.length > 0)
      bb.log.warn(`source: skipped symlinks: ${walked.symlinks.slice(0, 10).join(", ")}`);
    if (walked.tooLarge.length > 0)
      bb.log.warn(`source: skipped oversized files: ${walked.tooLarge.slice(0, 10).join(", ")}`);
    if (walked.truncated) {
      diskDirty = true;
      bb.log.warn(
        `source: sync cap reached (${Object.keys(walked.manifest).length} files); keeping previous state to avoid partial truncation`,
      );
      return { changed: false, catalogChanged: false, rulesChanged: false, manifestChanged: false };
    }
    if (watcher !== null) diskDirty = false;

    const nextTrash = await readTrashMeta();
    const trashChanged =
      nextTrash.length !== deleted.length ||
      nextTrash.some(
        (t, i) =>
          t.kind !== deleted[i]?.kind || t.key !== deleted[i]?.key || t.at !== deleted[i]?.at,
      );

    const manifestChanged = !sameManifest(walked.manifest, manifest);
    if (!manifestChanged && !trashChanged) {
      return { changed: false, catalogChanged: false, rulesChanged: false, manifestChanged: false };
    }

    // Prune stale cache entries for deleted files.
    for (const key of docCache.keys())
      if (!Object.hasOwn(walked.manifest, key)) docCache.delete(key);
    for (const key of ruleCache.keys())
      if (!Object.hasOwn(walked.manifest, key)) ruleCache.delete(key);
    for (const key of skillFileMetaCache.keys())
      if (!Object.hasOwn(walked.manifest, key)) skillFileMetaCache.delete(key);

    const nextDocs: LoadedDoc[] = [];
    const nextRulesWithOrder: { id: string; order: number | undefined; rule: Rule }[] = [];
    const nextValidRuleIds = new Set<string>();
    const skillFilesByName = new Map<string, LoadedSkillFile[]>();
    const disabledSkills = new Set<string>();
    const nextConflicts: string[] = [];

    const paths = Object.keys(walked.manifest).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    for (const relPath of paths) {
      const digest = walked.manifest[relPath]!;
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
        const cached = docCache.get(relPath);
        if (cached && cached.sha256 === digest.sha256) {
          if (cached.doc) nextDocs.push(cached.doc);
          continue;
        }
        const file = await readSyncFile(sourceDir, relPath);
        if (!file) continue;
        const text = editableText(file.bytes);
        if (text === null) {
          bb.log.warn(`source: ignoring non-UTF8 doc ${relPath}`);
          docCache.set(relPath, { sha256: file.sha256, doc: null });
          continue;
        }
        const parsed = parseDocFile(id, text);
        const loaded: LoadedDoc = { ...parsed, sha256: file.sha256, size: file.bytes.length };
        docCache.set(relPath, { sha256: file.sha256, doc: loaded });
        nextDocs.push(loaded);
        continue;
      }
      if (root === "rules") {
        if (segments.length !== 2 || !segments[1]!.endsWith(".md")) continue;
        const id = segments[1]!.slice(0, -3);
        const cached = ruleCache.get(relPath);
        if (cached && cached.sha256 === digest.sha256) {
          if (cached.parsed) {
            nextRulesWithOrder.push(cached.parsed);
            nextValidRuleIds.add(id);
          }
          continue;
        }
        const file = await readSyncFile(sourceDir, relPath);
        if (!file) continue;
        const text = editableText(file.bytes);
        if (text === null) {
          bb.log.warn(`source: ignoring non-UTF8 rule ${relPath}`);
          ruleCache.set(relPath, { sha256: file.sha256, parsed: null });
          continue;
        }
        const parsed = parseRuleFile(id, text);
        if ("error" in parsed) {
          bb.log.warn(`source: skipping invalid rule ${relPath}: ${parsed.error}`);
          ruleCache.set(relPath, { sha256: file.sha256, parsed: null });
          continue;
        }
        const entry = { id, order: parsed.order, rule: parsed.rule };
        ruleCache.set(relPath, { sha256: file.sha256, parsed: entry });
        nextRulesWithOrder.push(entry);
        nextValidRuleIds.add(id);
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
        let meta = skillFileMetaCache.get(relPath);
        if (!meta || meta.sha256 !== digest.sha256 || meta.executable !== digest.executable) {
          const file = await readSyncFile(sourceDir, relPath);
          if (!file) continue;
          meta = {
            sha256: file.sha256,
            executable: file.executable,
            size: file.bytes.length,
            text: editableText(file.bytes) !== null,
          };
          skillFileMetaCache.set(relPath, meta);
        }
        const list = skillFilesByName.get(skillName) ?? [];
        list.push({
          path: innerPath,
          executable: meta.executable,
          sha256: meta.sha256,
          size: meta.size,
          text: meta.text,
        });
        skillFilesByName.set(skillName, list);
      }
    }

    nextDocs.sort(compareOrdered);
    nextRulesWithOrder.sort(compareOrdered);
    const nextRules = nextRulesWithOrder.map((r) => r.rule);

    for (const key of skillHeaderCache.keys()) {
      if (!skillFilesByName.has(key)) skillHeaderCache.delete(key);
    }

    const nextSkills: LoadedSkill[] = [];
    for (const [name, files] of [...skillFilesByName.entries()].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )) {
      files.sort((a, b) =>
        a.path === "SKILL.md" ? -1 : b.path === "SKILL.md" ? 1 : a.path < b.path ? -1 : 1,
      );
      const skillFile = files.find((f) => f.path === "SKILL.md");
      let header = skillFile ? skillHeaderCache.get(name) : undefined;
      if (!skillFile || !header || header.sha256 !== skillFile.sha256) {
        let description = "";
        let valid = false;
        let error: string | undefined;
        if (!SKILL_NAME_PATTERN.test(name)) {
          error = `${JSON.stringify(name)} is not a valid bb skill name`;
        } else if (!skillFile) {
          error = "Missing or non-UTF8 SKILL.md";
        } else {
          const rawSkill = await readSyncFile(sourceDir, `skills/${name}/SKILL.md`);
          const text = rawSkill ? editableText(rawSkill.bytes) : null;
          if (text === null) {
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
        }
        if (error) bb.log.warn(`source: skill ${name} not publishable: ${error}`);
        header = {
          sha256: skillFile?.sha256 ?? "",
          description,
          valid,
          ...(error ? { error } : {}),
        };
        if (skillFile) skillHeaderCache.set(name, header);
      }

      nextSkills.push({
        name,
        description: header.description,
        enabled: !disabledSkills.has(name),
        valid: header.valid,
        ...(header.error ? { error: header.error } : {}),
        treeSha: treeSha(files),
        files,
      });
    }

    const nextRulesJson = JSON.stringify(nextRules);
    const rulesChanged = nextRulesJson !== JSON.stringify(rules);
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
    validRuleIds = nextValidRuleIds;
    conflicts = nextConflicts;
    deleted = nextTrash;

    if (catalogChanged) revision++;
    if (rulesChanged) {
      const nextRulesHash = sha256Bytes(nextRulesJson);
      // On boot, keep persisted rulesRevision when rules match what was saved before reload.
      if (booted || persistedRulesHash !== nextRulesHash) {
        rulesRevision++;
        await persistRevisions(nextRulesHash);
      }
    }

    if (reason !== "local" && (catalogChanged || rulesChanged || manifestChanged)) {
      emit({
        reason,
        originHostId,
        revision,
        rulesRevision,
        catalogChanged,
        rulesChanged,
        manifestChanged,
      });
    }
    return {
      changed: catalogChanged || rulesChanged || manifestChanged,
      catalogChanged,
      rulesChanged,
      manifestChanged,
    };
  }

  /** Reloads after a local mutation and emits one `local` change event. */
  async function commitLocal(force: { catalog?: boolean; rules?: boolean } = {}): Promise<void> {
    const reloaded = await reloadFromDiskUnlocked("local");
    emit({
      reason: "local",
      revision,
      rulesRevision,
      catalogChanged: reloaded.catalogChanged || force.catalog === true,
      rulesChanged: reloaded.rulesChanged || force.rules === true,
      manifestChanged: reloaded.manifestChanged || true,
    });
  }

  /** Reads legacy SQLite + KV data for one-time migration (read-only). */
  async function readLegacyData(options: { lenient?: boolean } = {}): Promise<LegacyData> {
    let sqliteData: Omit<LegacyData, "rules"> = { docs: [], skills: [], deleted: [] };
    if (await pathExists(legacyDbPath)) {
      const opened = await openReadOnlySqlite(legacyDbPath);
      try {
        sqliteData = readLegacySqlite(opened.db);
      } finally {
        opened.close();
      }
    }
    const rawKv = await bb.storage.kv.get(LEGACY_KV_KEY);
    const legacyRules = rawKv
      ? parseLegacyRules(rawKv, {
          lenient: options.lenient,
          onWarning: (msg) => bb.log.warn(msg),
        })
      : [];
    return { ...sqliteData, rules: legacyRules };
  }

  /** Cleans up any interrupted migration staging/backup folders on boot. */
  async function recoverInterruptedMigrationDirs(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(pluginDir);
    } catch {
      return;
    }
    let sourcePresent = await pathExists(sourceDir);
    const backups = entries.filter((e) => e.startsWith(".source-backup-")).sort();
    if (!sourcePresent && backups.length > 0) {
      const latestBackup = backups.at(-1)!;
      try {
        // Previous swap moved sourceDir aside before crashing; restore it!
        await rename(join(pluginDir, latestBackup), sourceDir);
        sourcePresent = true;
      } catch (error) {
        bb.log.error(
          `failed to restore interrupted migration backup ${latestBackup}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    for (const entry of entries) {
      if (entry.startsWith(".source-migrating-")) {
        await rm(join(pluginDir, entry), { recursive: true, force: true }).catch(() => undefined);
      } else if (entry.startsWith(".source-backup-") && sourcePresent) {
        // Only remove old backups once sourceDir is confirmed present.
        await rm(join(pluginDir, entry), { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  async function maybeAutoMigrate(): Promise<void> {
    if (await hasMigrationMarker(markerPath)) {
      migrationBlockedReason = null;
      return;
    }
    const hasFiles = await hasExistingSourceFiles(sourceDir);
    let legacy: LegacyData;
    try {
      legacy = await readLegacyData({ lenient: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // Block publishing and mirror sync unconditionally whether source/ is empty or partial,
      // so an unreadable/corrupt legacy DB never unlinks existing published skills or AGENTS.md.
      migrationBlockedReason = `Failed to read legacy catalog/rules during startup migration: ${msg}`;
      bb.log.error(migrationBlockedReason);
      return;
    }
    const hasLegacy = legacy.docs.length > 0 || legacy.skills.length > 0 || legacy.rules.length > 0;
    if (!hasLegacy) return;

    if (hasFiles) {
      // Partial source/ exists alongside unmigrated legacy data with no migration.json!
      // Refuse silent truncation of published user-tier catalog; let operator run `migrate`.
      migrationBlockedReason =
        "Partial source/ folder found alongside unmigrated legacy data without migration.json. " +
        "Skipping automatic publish to prevent catalog truncation; run `bb agent-instructions migrate` to inspect or `bb agent-instructions migrate --apply --force` to complete migration.";
      bb.log.error(migrationBlockedReason);
      return;
    }

    try {
      const report = await runMigration({
        data: legacy,
        targetDir: sourceDir,
        tmpDir,
        markerPath,
        apply: true,
      });
      migrationBlockedReason = null;
      for (const warning of report.plan.warnings) bb.log.warn(`migration: ${warning}`);
      bb.log.info(
        `migrated legacy catalog to ${sourceDir}: ${report.plan.docs.length} docs, ${report.plan.rules.length} rules, ${report.plan.skills.length} skills (${report.verification.skillFilesChecked} files)`,
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      migrationBlockedReason = `Startup migration failed: ${msg}`;
      bb.log.error(migrationBlockedReason);
    }
  }

  /** Writes `nextRules` to `source/rules/*.md` and removes only previously valid deleted rule files. */
  async function writeRulesUnlocked(nextRules: Rule[]): Promise<void> {
    const validated = rulesSchema.parse(nextRules);
    const seenLower = new Set<string>();
    for (const rule of validated) {
      if (!ITEM_ID_PATTERN.test(rule.id))
        throw new Error(`Invalid rule id ${JSON.stringify(rule.id)}`);
      const lower = rule.id.toLowerCase();
      if (seenLower.has(lower))
        throw new Error(`Duplicate rule id (case-insensitive): ${JSON.stringify(rule.id)}`);
      seenLower.add(lower);
    }
    await ensureSourceFolders(sourceDir);
    const wantedIds = new Set(validated.map((r) => r.id));
    // Only delete files corresponding to previously loaded valid rules that were removed;
    // unparseable `rules/*.md` files stay untouched on disk so user work is never lost.
    for (const oldId of validRuleIds) {
      if (!wantedIds.has(oldId)) {
        await deleteSyncFileAndPrune(sourceDir, `rules/${oldId}.md`);
      }
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

  async function incomingLinks(target: string): Promise<string[]> {
    const others: { name: string; files: { path: string; bytes: Uint8Array }[] }[] = [];
    for (const s of skills) {
      if (!s.enabled || !s.valid || s.name === target) continue;
      const textFiles = s.files.filter((f) => f.text);
      const loaded = await readSkillFileBuffers(s.name, textFiles);
      others.push({ name: s.name, files: loaded });
    }
    return linksInto(target, others).map(
      (file) => `${file} links into ${target}, which agents will no longer find`,
    );
  }

  async function applyCatalogChangeUnlocked(change: CatalogChange): Promise<ChangeResult> {
    // Always refresh from disk first so external edits are caught as conflicts before writing.
    await reloadFromDiskUnlocked("disk");
    await ensureSourceFolders(sourceDir);

    switch (change.op) {
      case "saveFile": {
        const skill = skills.find((s) => s.name === change.skill);
        if (!skill) return conflict(`${change.skill} no longer exists`);
        const err = pathError(change.path, skill.name);
        if (err) return invalid(err);
        const current = skill.files.find((f) => f.path === change.path);
        if ((current?.sha256 ?? null) !== change.expectedSha256) {
          return conflict(
            current ? `${change.path} changed since you opened it` : `${change.path} was deleted`,
          );
        }
        if (current && !current.text)
          return invalid(`${change.path} is not a text file, so it cannot be edited here`);
        const bytes = Buffer.from(change.content, "utf8");
        const executable = (current?.executable ?? false) || change.content.startsWith("#!");
        const existingBuffers = await readSkillFileBuffers(skill.name, skill.files);
        const nextFile = {
          path: change.path,
          executable,
          sha256: sha256Bytes(bytes),
          bytes,
        };
        const nextFiles = current
          ? existingBuffers.map((f) => (f.path === change.path ? nextFile : f))
          : [...existingBuffers, nextFile];
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
        await commitLocal({ catalog: true });
        const updatedSkill = skills.find((s) => s.name === skill.name);
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
        const existingBuffers = await readSkillFileBuffers(
          skill.name,
          skill.files.filter((f) => f !== current),
        );
        const check = checkSkillTree(skill.name, existingBuffers, new Set(), enabledSkillNames());
        if (check.errors.length > 0) return invalid(...check.errors);
        await deleteSyncFileAndPrune(sourceDir, `skills/${skill.name}/${change.path}`);
        await commitLocal({ catalog: true });
        const updatedSkill = skills.find((s) => s.name === skill.name);
        return {
          outcome: "saved",
          revision,
          treeSha: updatedSkill?.treeSha ?? treeSha(existingBuffers),
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
        await commitLocal({ catalog: true });
        const created = skills.find((s) => s.name === name);
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
        const warnings = await incomingLinks(skill.name);
        const buffers = await readSkillFileBuffers(skill.name, skill.files);
        await writeTrash({
          kind: "skill",
          key: skill.name,
          name: skill.name,
          at: Date.now(),
          enabled: skill.enabled,
          files: buffers.map((f) => ({
            path: f.path,
            executable: f.executable,
            base64: f.bytes.toString("base64"),
          })),
        });
        for (const f of skill.files) {
          await deleteSyncFileAndPrune(sourceDir, `skills/${skill.name}/${f.path}`);
        }
        await deleteSyncFileAndPrune(sourceDir, `skills/${skill.name}/.disabled`);
        await rm(join(sourceDir, "skills", skill.name), { recursive: true, force: true }).catch(
          () => undefined,
        );
        await commitLocal({ catalog: true });
        return { outcome: "saved", revision, warnings };
      }

      case "setSkillEnabled": {
        const skill = skills.find((s) => s.name === change.name);
        if (!skill) return conflict(`${change.name} no longer exists`);
        const warnings = change.enabled ? [] : await incomingLinks(skill.name);
        const marker = `skills/${skill.name}/.disabled`;
        if (change.enabled) await deleteSyncFileAndPrune(sourceDir, marker);
        else await writeSyncFileAtomic(sourceDir, tmpDir, marker, new Uint8Array(), false);
        await commitLocal({ catalog: true });
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
        await commitLocal({ catalog: true });
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
          await commitLocal({ catalog: true });
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
        await commitLocal({ catalog: true });
        return {
          outcome: "saved",
          revision,
          sha256: sha256Bytes(bytes),
          warnings: [],
        };
      }

      case "restore":
      case "forget": {
        const meta = deleted.find((d) => d.kind === change.kind && d.key === change.key);
        if (!meta) return conflict("It is no longer in Recently deleted");
        if (change.op === "restore") {
          const taken =
            change.kind === "skill"
              ? skills.some((s) => s.name.toLowerCase() === change.key.toLowerCase())
              : docs.some((d) => d.id.toLowerCase() === change.key.toLowerCase());
          if (taken)
            return invalid(`Something named ${change.key} exists now; rename or delete it first`);
          const entry = await readTrashPayload(meta);
          if (!entry) return conflict("It is no longer in Recently deleted");
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
        await commitLocal({ catalog: true });
        const restoredSkill =
          change.op === "restore" && change.kind === "skill"
            ? skills.find((s) => s.name === change.key)
            : undefined;
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

    /** Non-null when boot detected an incomplete or failed migration state. */
    migrationBlocked: (): string | null => migrationBlockedReason,
    publishBlocked: (): string | null => migrationBlockedReason,
    clearMigrationBlocked(): void {
      migrationBlockedReason = null;
    },

    /** Loads the source folder (auto-migrating once if legacy data exists and source is empty). */
    async load(): Promise<void> {
      await withLock(async () => {
        await recoverInterruptedMigrationDirs();
        await ensureSourceFolders(sourceDir);
        await loadPersistedRevisions();
        await maybeAutoMigrate();
        await reloadFromDiskUnlocked("local");
        booted = true;
      });
    },

    /** Starts watching `sourceDir` for external edits made by agents or users. */
    startWatch(): void {
      if (disposed) return;
      watching = true;
      if (watcher) return;
      try {
        watcher = watch(sourceDir, { recursive: true }, (_eventType, filename) => {
          if (typeof filename === "string") {
            const parts = filename.split(/[\\/]/);
            if (parts.some((p) => p && isIgnoredEntryName(p))) return;
          }
          diskDirty = true;
          scheduleWatchReload();
        });
        if (booted && !lastWalk.truncated) diskDirty = false;
        watcher.on("error", (error) => {
          diskDirty = true;
          bb.log.warn(`source watcher error: ${error.message}`);
        });
      } catch (error) {
        diskDirty = true;
        bb.log.warn(
          `could not start source folder watch: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },

    /** Re-attaches `fs.watch` to `sourceDir`'s new inode after an atomic directory swap. */
    restartWatch(): void {
      if (disposed || !watching) return;
      if (watchTimer) {
        clearTimeout(watchTimer);
        watchTimer = null;
      }
      watcher?.close();
      watcher = null;
      diskDirty = true;
      this.startWatch();
    },

    dispose(): void {
      disposed = true;
      watching = false;
      diskDirty = true;
      if (watchTimer) {
        clearTimeout(watchTimer);
        watchTimer = null;
      }
      watcher?.close();
      watcher = null;
      listeners.clear();
    },

    /** True when the filesystem watcher is active and has observed no local disk edits since the last reload. */
    isDiskClean: (): boolean => watcher !== null && !diskDirty && !lastWalk.truncated,

    onChange(listener: (event: SourceChangeEvent) => void): () => void {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    /** Serializes an external operation (such as mirror sync or migration) with store mutations. */
    withLock,

    /** Forces an incremental stat-cached reload from disk (inside the lock). */
    reloadFromDisk(
      reason: SourceChangeEvent["reason"] = "disk",
      originHostId?: string,
    ): Promise<{
      changed: boolean;
      catalogChanged: boolean;
      rulesChanged: boolean;
      manifestChanged: boolean;
    }> {
      return withLock(() => reloadFromDiskUnlocked(reason, originHostId));
    },

    /** Reloads from disk when caller already holds `withLock`. */
    reloadUnlocked: reloadFromDiskUnlocked,

    /** Current in-memory synced manifest snapshot. */
    manifest: (): SyncManifest => ({ ...manifest }),

    /** Metadata from the most recent source tree walk (symlinks, tooLarge, truncated). */
    lastWalk: (): WalkResult => lastWalk,

    /** Reads legacy SQLite + KV data (read-only) for `migrate` CLI. */
    readLegacyData,

    // --- PublishSource contract ---
    publishable(): { name: string; treeSha: string }[] {
      return skills
        .filter((s) => s.enabled && s.valid)
        .map((s) => ({ name: s.name, treeSha: s.treeSha }));
    },

    async skillFiles(
      name: string,
    ): Promise<{ path: string; executable: boolean; bytes: Uint8Array }[]> {
      const found = skills.find((s) => s.name === name);
      if (!found) return [];
      const buffers = await readSkillFileBuffers(name, found.files);
      return buffers.map((f) => ({
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

    findDoc(id: string) {
      const found = docs.find((d) => d.id === id);
      return found
        ? {
            id: found.id,
            name: found.name,
            enabled: found.enabled,
            characters: found.body.length,
            sha256: found.sha256,
          }
        : null;
    },

    findSkill(name: string) {
      const found = skills.find((s) => s.name === name);
      return found
        ? {
            name: found.name,
            description: found.description,
            enabled: found.enabled,
            treeSha: found.treeSha,
            files: found.files.map((f) => ({
              path: f.path,
              executable: f.executable,
              size: f.size,
              text: f.text,
            })),
          }
        : null;
    },

    skills() {
      return skills.map((s) => ({
        name: s.name,
        description: s.description,
        enabled: s.enabled,
        valid: s.valid,
        ...(s.error ? { error: s.error } : {}),
        files: s.files.length,
        bytes: s.files.reduce((sum, f) => sum + f.size, 0),
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
            size: f.size,
            text: f.text,
          })),
        })),
        deleted: deleted.map((d) => ({ kind: d.kind, key: d.key, name: d.name, at: d.at })),
      };
    },

    /** Reads one doc or skill file directly from disk (targeted single-file check, no full walk). */
    async readFileFresh(target: { doc: string } | { skill: string; path: string }) {
      if ("doc" in target) {
        if (!ITEM_ID_PATTERN.test(target.doc)) return null;
        const raw = await readSyncFile(sourceDir, `instructions/${target.doc}.md`);
        if (!raw) return null;
        const text = editableText(raw.bytes);
        if (text === null) return null;
        const parsed = parseDocFile(target.doc, text);
        return {
          bytes: Buffer.from(parsed.body, "utf8"),
          sha256: raw.sha256,
          executable: false,
        };
      }
      if (pathError(target.path, target.skill) !== null) return null;
      const raw = await readSyncFile(sourceDir, `skills/${target.skill}/${target.path}`);
      if (!raw) return null;
      return { bytes: raw.bytes, sha256: raw.sha256, executable: raw.executable };
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
        await commitLocal({ rules: true });
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
        await commitLocal({ rules: true });
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
