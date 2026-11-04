import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readlink,
  rename,
  rm,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { treeSha } from "./tree.ts";

/**
 * Publishes the catalog into bb's user tier, which bb core scans, syncs to
 * every host, and gives to every thread.
 *
 * Each enabled skill is an immutable, read-only tree named by its content
 * hash under this plugin's data folder; `<dataDir>/skills/<name>` is a
 * relative link to it. The enabled global docs work the same way through
 * `<dataDir>/AGENTS.md`. Trees are built in a staging folder and moved into
 * place whole, and a link is replaced with one `rename()`, so a skill is never
 * missing or half built. bb reads through the link at every level, so a scan
 * that overlaps a swap can still mix old and new files; its next scan is
 * whole. bb refuses to edit or delete a linked user skill, which keeps this
 * plugin the only writer.
 *
 * A link into this plugin's folder is ours; anything else in the user tier
 * belongs to the user and is never touched. Every run derives its work from
 * what is on disk, and deletes by moving things out first, so a run after a
 * crash at any point converges.
 *
 * The SDK says not to write in `experimental_dataDir`; the plugin owner
 * approved this module doing so until bb takes long instructions from plugins.
 */

/** What publishing reads from the catalog. */
export type PublishSource = {
  publishable(): { name: string; treeSha: string }[];
  skillFiles(name: string): { path: string; executable: boolean; bytes: Uint8Array }[];
  docs(): { body: string; enabled: boolean }[];
};

export type PublishReport = {
  /** Skills that gained a link, moved to a new tree, or lost their link. */
  linked: string[];
  relinked: string[];
  unlinked: string[];
  unchanged: number;
  agentsMd: "linked" | "relinked" | "unlinked" | "unchanged" | "none" | "conflict";
  /** User-tier entries this plugin did not create that block a publish; left alone. */
  conflicts: string[];
  /** Skills, or AGENTS.md, that could not be published this time; the rest still were. */
  failed: { name: string; error: string }[];
  /** Skills that changed while this run read them; the run their change queued publishes them. */
  deferred: string[];
  /** Trees and global-text copies deleted because nothing uses them any more. */
  removed: number;
};

type Entry = { kind: "missing" } | { kind: "ours"; target: string } | { kind: "foreign" };
type Outcome = "linked" | "relinked" | "unlinked" | "unchanged" | "conflict" | "none";
type SourceFile = ReturnType<PublishSource["skillFiles"]>[number];

const TRASH = "trash";
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code;
const isMissing = (error: unknown) => errorCode(error) === "ENOENT";
const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const stagingName = (kind: string) => `${kind}-${randomBytes(6).toString("hex")}`;

async function names(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

/** Whether `path` is absent, a link into `own`, or something else. */
async function inspect(path: string, own: string): Promise<Entry> {
  try {
    if (!(await lstat(path)).isSymbolicLink()) return { kind: "foreign" };
  } catch (error) {
    if (isMissing(error)) return { kind: "missing" };
    throw error;
  }
  const target = resolve(dirname(path), await readlink(path));
  return target.startsWith(own + sep) ? { kind: "ours", target } : { kind: "foreign" };
}

/** Deletes `path` where it is, even though its folders are read-only. */
async function wipe(path: string): Promise<void> {
  async function unlock(dir: string) {
    await chmod(dir, 0o755);
    for (const entry of await readdir(dir, { withFileTypes: true }))
      if (entry.isDirectory()) await unlock(join(dir, entry.name));
  }
  try {
    if ((await lstat(path)).isDirectory()) await unlock(path);
  } catch (error) {
    if (!isMissing(error)) throw error; // another run may be wiping it too
  }
  await rm(path, { recursive: true, force: true });
}

/**
 * Deletes a tree or copy without ever leaving part of it at `path`: it moves
 * to a trash folder first, which the next run clears if this one stops.
 */
async function discard(path: string, own: string): Promise<void> {
  const trash = join(own, stagingName(TRASH));
  try {
    // Moving a folder to another parent needs write access to it.
    if ((await lstat(path)).isDirectory()) await chmod(path, 0o755);
    await rename(path, trash);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  await wipe(trash);
}

/** Replaces whatever link is at `path` with one to `target`, in one step. */
async function placeLink(path: string, target: string, staging: string) {
  await mkdir(staging, { recursive: true });
  // Staged outside the user tier, so a scan never meets a half-made entry.
  const staged = join(staging, stagingName("link"));
  await symlink(relative(dirname(path), target), staged);
  await mkdir(dirname(path), { recursive: true });
  await rename(staged, path);
}

/** A skill changed after this run listed it; the change queued its own publish. */
class CatalogChanged extends Error {}

/** The files to write, after checking that they are the tree `path` is named for. */
function verifiedFiles(path: string, files: SourceFile[]): SourceFile[] {
  const hashed = files.map((f) => ({
    path: f.path,
    executable: f.executable,
    sha256: sha256(f.bytes),
  }));
  if (treeSha(hashed) !== basename(path))
    throw new CatalogChanged(`${basename(dirname(path))} changed while it was being published`);
  return files;
}

/** Builds a read-only tree at `path` unless it is already there. */
async function ensureTree(path: string, files: () => SourceFile[], staging: string) {
  try {
    await lstat(path);
    // A run that stopped right after its rename left the root writable.
    await chmod(path, 0o555);
    return;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const contents = verifiedFiles(path, files());
  const staged = join(staging, stagingName("tree"));
  const folders = new Set<string>();
  await mkdir(staging, { recursive: true });
  await mkdir(staged);
  for (const file of contents) {
    const target = join(staged, file.path);
    for (let dir = dirname(target); dir !== staged; dir = dirname(dir)) folders.add(dir);
    // If another run cleared staging, stop rather than rebuild part of the tree.
    const made = await mkdir(dirname(target), { recursive: true });
    if (made !== undefined && !made.startsWith(staged + sep))
      throw new Error("Another publish cleared the staging folder; publish again");
    await writeFile(target, file.bytes);
    await chmod(target, file.executable ? 0o555 : 0o444);
  }
  // Deepest first, so each folder is still writable while its children change.
  for (const dir of [...folders].sort((a, b) => b.length - a.length)) await chmod(dir, 0o555);
  await mkdir(dirname(path), { recursive: true });
  try {
    // Moving a folder needs write access to it, so its root is locked after.
    await rename(staged, path);
  } catch (error) {
    if (errorCode(error) !== "ENOTEMPTY" && errorCode(error) !== "EEXIST") throw error;
    await wipe(staged); // another run built the same tree first
  }
  await chmod(path, 0o555);
}

/** Writes a read-only copy of `text` at `path` unless it is already there. */
async function ensureText(path: string, text: string, staging: string) {
  try {
    await lstat(path);
    return;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  await mkdir(staging, { recursive: true });
  const staged = join(staging, stagingName("text"));
  await writeFile(staged, text);
  await chmod(staged, 0o444);
  await mkdir(dirname(path), { recursive: true });
  await rename(staged, path);
}

/** Moves the link at `path` to `want`, or removes it when `want` is null. */
async function reconcile(
  path: string,
  entry: Entry,
  want: string | null,
  staging: string,
): Promise<Outcome> {
  if (entry.kind === "foreign") return want === null ? "none" : "conflict";
  if (want === null) {
    if (entry.kind === "missing") return "none";
    await unlink(path);
    return "unlinked";
  }
  if (entry.kind === "ours" && entry.target === want) return "unchanged";
  await placeLink(path, want, staging);
  return entry.kind === "missing" ? "linked" : "relinked";
}

/** Discards children of `dir`, `depth` levels down, that `keep` does not list. */
async function collect(
  dir: string,
  depth: number,
  keep: ReadonlySet<string>,
  own: string,
): Promise<number> {
  let removed = 0;
  for (const name of await names(dir)) {
    const path = join(dir, name);
    if (keep.has(path)) continue;
    if (depth > 1 && (await lstat(path)).isDirectory()) {
      removed += await collect(path, depth - 1, keep, own);
      if ((await names(path)).length === 0) await rmdir(path);
    } else {
      await discard(path, own);
      removed++;
    }
  }
  return removed;
}

/** The global text agents get: enabled docs in order, or null when there are none. */
export function globalText(docs: ReturnType<PublishSource["docs"]>): string | null {
  const text = docs
    .filter((d) => d.enabled && d.body.trim().length > 0)
    .map((d) => d.body.trim())
    .join("\n\n");
  return text.length > 0 ? `${text}\n` : null;
}

/** Makes bb's user tier match the catalog. Safe to run again at any time. */
export async function publish(
  dataDir: string,
  pluginId: string,
  source: PublishSource,
): Promise<PublishReport> {
  const own = join(dataDir, "plugins", pluginId);
  const skillsDir = join(dataDir, "skills");
  const agentsMd = join(dataDir, "AGENTS.md");
  const trees = join(own, "skill-trees");
  const texts = join(own, "agents-md");
  const staging = join(own, "publish-tmp");
  // Whatever an interrupted run left half made or half deleted.
  await discard(staging, own);
  for (const name of await names(own))
    if (name.startsWith(`${TRASH}-`)) await wipe(join(own, name));

  const desired = new Map(
    source.publishable().map((s) => [s.name, join(trees, s.name, s.treeSha)] as const),
  );
  const entries = await skillEntries(skillsDir, own, desired.keys());
  const text = globalText(source.docs());
  const textPath = text === null ? null : join(texts, `${sha256(text)}.md`);
  const agentsEntry = await inspect(agentsMd, own);

  const report: PublishReport = {
    linked: [],
    relinked: [],
    unlinked: [],
    unchanged: 0,
    agentsMd: "none",
    conflicts: [],
    failed: [],
    deferred: [],
    removed: 0,
  };
  for (const [name, entry] of entries)
    await publishSkill(report, name, entry, desired.get(name) ?? null, {
      skillsDir,
      staging,
      source,
    });
  try {
    if (text !== null && textPath !== null && agentsEntry.kind !== "foreign")
      await ensureText(textPath, text, staging);
    report.agentsMd = await reconcile(agentsMd, agentsEntry, textPath, staging);
    if (report.agentsMd === "conflict") report.conflicts.push("AGENTS.md");
  } catch (error) {
    report.failed.push({ name: "AGENTS.md", error: (error as Error).message });
  }

  // Keep what this run wants and whatever a link points to now, which covers a
  // tree another run linked meanwhile.
  const keep = new Set<string>(desired.values());
  if (textPath) keep.add(textPath);
  for (const target of await linkTargets(skillsDir, agentsMd, own)) keep.add(target);
  report.removed = (await collect(trees, 2, keep, own)) + (await collect(texts, 1, keep, own));
  return report;
}

/**
 * Each entry in `<dataDir>/skills`, plus each skill to publish. A wanted name
 * is inspected rather than assumed missing: on a case-insensitive disk,
 * `dev` can be the user's `Dev`.
 */
async function skillEntries(skillsDir: string, own: string, wanted: Iterable<string>) {
  const entries = new Map<string, Entry>();
  for (const name of await names(skillsDir))
    entries.set(name, await inspect(join(skillsDir, name), own));
  for (const name of wanted)
    if (!entries.has(name)) entries.set(name, await inspect(join(skillsDir, name), own));
  return entries;
}

/** Where this plugin's links in the user tier point now. */
async function linkTargets(skillsDir: string, agentsMd: string, own: string) {
  const targets: string[] = [];
  for (const path of [...(await names(skillsDir)).map((n) => join(skillsDir, n)), agentsMd]) {
    const entry = await inspect(path, own);
    if (entry.kind === "ours") targets.push(entry.target);
  }
  return targets;
}

/** Builds and links one skill. One that cannot be published must not hold back the others. */
async function publishSkill(
  report: PublishReport,
  name: string,
  entry: Entry,
  want: string | null,
  where: { skillsDir: string; staging: string; source: PublishSource },
) {
  try {
    if (want && entry.kind !== "foreign")
      await ensureTree(want, () => where.source.skillFiles(name), where.staging);
    record(report, name, await reconcile(join(where.skillsDir, name), entry, want, where.staging));
  } catch (error) {
    if (error instanceof CatalogChanged) report.deferred.push(name);
    else report.failed.push({ name, error: (error as Error).message });
  }
}

function record(report: PublishReport, name: string, outcome: Outcome) {
  if (outcome === "conflict") report.conflicts.push(`skills/${name}`);
  else if (outcome === "unchanged") report.unchanged++;
  else if (outcome !== "none") report[outcome].push(name);
}

/** Runs publishes one at a time, each reading the catalog as it is when it starts. */
export function openPublisher(bb: Pick<BbPluginApi, "server" | "pluginId">, source: PublishSource) {
  let queue: Promise<unknown> = Promise.resolve();
  let last: { at: number; report: PublishReport } | { at: number; error: string } | null = null;
  return {
    run(): Promise<PublishReport> {
      const next = queue.then(() => publish(bb.server.experimental_dataDir, bb.pluginId, source));
      queue = next.then(
        (report) => (last = { at: Date.now(), report }),
        (error: unknown) => (last = { at: Date.now(), error: (error as Error).message }),
      );
      return next;
    },
    /** The latest finished publish since this plugin loaded. */
    last: () => last,
  };
}
export type Publisher = ReturnType<typeof openPublisher>;
