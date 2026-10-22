import { isUtf8 } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import type {
  ExperimentalHostRpcContext,
  ExperimentalHostWatchEvent,
  ExperimentalHostWatchSubscription,
} from "@get-bb/plugin-sdk/host";
import { generationJob, type GenerationJob } from "../shared/generation.ts";
import {
  canvasAssetRoots,
  changeLimit,
  type CanvasChange,
  type CanvasEntry,
  type CanvasFile,
  type CanvasRead,
  type studioHostSignals,
} from "../shared/canvas-contract.ts";
import type { Game } from "../shared/schema.ts";
import { pathTools, projectFile } from "../shared/node/paths.ts";

/*
 * The canvas as the host sees it, next to the files. A read gathers every
 * file a workspace shows into content-addressed entries and fingerprints
 * them, so the server hears "unchanged" or only what changed, in one call.
 *
 * A read by an open studio is also its interest: it keeps the canvas watched
 * for LEASE_MS, and the studio's next read renews it. A change on disk is
 * compared with what the watch last saw, entry by entry, and a difference is
 * said once. Reads only read, so a read never wakes anyone; churn that
 * changes no entry, such as temporary files and input snapshots, is never a
 * change.
 */

/** File access for one game directory, with BB's file semantics. Paths are root-relative. */
export interface CanvasDisk {
  /** The file, or null when it does not exist. */
  read(root: string, path: string): Promise<CanvasFile | null>;
  /** Files below a folder, relative to it, or null when the folder does not exist. */
  list(
    root: string,
    folder: string,
    limit: number,
  ): Promise<{ files: string[]; truncated: boolean } | null>;
  /** Writes when the file still has `expectedSha256` (null: no file). The new hash, or null on a conflict. */
  write(
    root: string,
    path: string,
    content: string,
    encoding: CanvasFile["contentEncoding"],
    expectedSha256: string | null,
  ): Promise<string | null>;
  /** Whether a folder exists to watch. */
  directory(root: string, folder: string): Promise<boolean>;
}
/** The generation jobs a canvas shows, and where they were read. */
export type CanvasJobs = (
  root: string,
) => Promise<{ workspacePath: string | null; jobs: GenerationJob[]; stale: boolean }>;
type Context = Pick<
  ExperimentalHostRpcContext<typeof studioHostSignals>,
  "experimental_watch" | "experimental_emitSignal"
>;

/** How long one read keeps its canvas watched. Longer than twice the studio's safety poll. */
export const LEASE_MS = 150_000;
/** A burst of writes, such as a generation landing its outputs, is one change. */
const DEBOUNCE_MS = 300;
const MAX_WAIT_MS = 2_000;
/** Larger files stay out of workspace reads; host results are capped at 8 MiB. */
const MAX_FILE_BYTES = 4 * 1024 * 1024;
/** A read whose entries outgrow one host result sends them in parts of about this size. */
const PART_BYTES = 6 * 1024 * 1024;
const INPUT_LIMIT_BYTES = 14 * 1024 * 1024;
const idPattern = /^[a-zA-Z0-9_-]{1,100}$/;
const recordPattern = /^[a-zA-Z0-9_-]{1,100}\.json$/;
/** Validate input formats and bound snapshot size before copying on the host. */
function inputExtension(path: string, file: CanvasFile) {
  const extension = /\.(png|jpe?g|webp|glb|obj|fbx|stl)$/i.exec(path)?.[1]?.toLowerCase();
  const isModel = extension !== undefined && ["glb", "obj", "fbx", "stl"].includes(extension);
  const limit = isModel ? 512 * 1024 * 1024 : INPUT_LIMIT_BYTES;
  if (
    !extension ||
    (!isModel && file.contentEncoding !== "base64") ||
    file.sizeBytes > limit ||
    Buffer.byteLength(file.content, file.contentEncoding) > limit
  )
    throw new Error(
      isModel
        ? "Generation model inputs must be GLB, OBJ, FBX or STL files under 512 MiB."
        : "Generation image inputs must be PNG, JPEG or WebP files under 14 MiB.",
    );
  return extension === "jpeg" ? "jpg" : extension;
}
/** BB reads these as binary images; everything else is text when it is valid UTF-8. */
const imagePattern = /\.(png|jpe?g|gif|webp|avif|bmp|ico|tiff?|heic|heif)$/i;

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

/** The server's rule for a missing file, plus a path through a file that is not a folder. */
function missing(error: unknown): boolean {
  return (
    error instanceof Error &&
    (/ENOENT|no such file or directory|Path does not exist/i.test(error.message) ||
      ("code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")))
  );
}

function inside(root: string, path: string): boolean {
  const paths = pathTools(root);
  const rel = paths.relative(root, path);
  return (
    rel === "" || (rel !== ".." && !rel.startsWith(`..${paths.sep}`) && !paths.isAbsolute(rel))
  );
}

/** The real location of `path`, which must stay inside the game directory, or null when it is gone. */
async function contained(root: string, path: string): Promise<string | null> {
  let resolved: string;
  try {
    resolved = await realpath(path);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
  if (!inside(await realpath(root), resolved))
    throw new Error("Canvas files must stay inside the game directory.");
  return resolved;
}

function describe(path: string, bytes: Buffer): CanvasFile {
  const base64 = imagePattern.test(path) || !isUtf8(bytes);
  return {
    content: bytes.toString(base64 ? "base64" : "utf8"),
    contentEncoding: base64 ? "base64" : "utf8",
    sha256: sha256(bytes),
    sizeBytes: bytes.length,
  };
}

/** BB's file listing: depth first, without dot names, node_modules or symbolic links. */
async function walk(directory: string, prefix: string, into: string[], max: number) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (into.length >= max) return;
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.isSymbolicLink())
      continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await walk(`${directory}/${entry.name}`, relative, into, max);
    else into.push(relative);
  }
}

const writing = new Map<string, Promise<unknown>>();
async function locked<T>(
  queues: Map<string, Promise<unknown>>,
  key: string,
  work: () => Promise<T>,
) {
  const next = (queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(work);
  queues.set(key, next);
  try {
    return await next;
  } finally {
    if (queues.get(key) === next) queues.delete(key);
  }
}

export const nodeDisk: CanvasDisk = {
  async read(root, path) {
    const resolved = await contained(root, projectFile(root, path));
    if (!resolved) return null;
    try {
      return describe(path, await readFile(resolved));
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  },
  async list(root, folder, limit) {
    const resolved = await contained(root, projectFile(root, folder));
    if (!resolved || !(await stat(resolved)).isDirectory()) return null;
    const files: string[] = [];
    await walk(resolved, "", files, limit + 1);
    return { files: files.slice(0, limit), truncated: files.length > limit };
  },
  async write(root, path, content, encoding, expectedSha256) {
    const target = projectFile(root, path);
    const folder = pathTools(root).dirname(target);
    await mkdir(folder, { recursive: true });
    await contained(root, folder);
    return locked(writing, target, async () => {
      const current = async () => (await nodeDisk.read(root, path))?.sha256 ?? null;
      if ((await current()) !== expectedSha256) return null;
      const bytes = Buffer.from(content, encoding);
      const temporary = `${target}.${randomUUID()}.tmp`;
      await writeFile(temporary, bytes, { flag: "wx" });
      try {
        // An edit made while the temporary file was written still wins.
        if ((await current()) !== expectedSha256) return null;
        if (expectedSha256 !== null) await rename(temporary, target);
        else {
          try {
            await link(temporary, target);
          } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "EEXIST") return null;
            throw error;
          }
        }
        return sha256(bytes);
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
    });
  },
  async directory(root, folder) {
    try {
      return (await stat(projectFile(root, folder))).isDirectory();
    } catch {
      return false;
    }
  },
};

/** Job records read straight from disk, for when the runner cannot vouch for them. */
export async function readJobFiles(disk: CanvasDisk, root: string): Promise<GenerationJob[]> {
  const listing = await disk.list(root, "canvas/jobs", 1000);
  const jobs = await Promise.all(
    (listing?.files ?? []).map(async (name) => {
      if (!recordPattern.test(name)) return [];
      try {
        const file = await disk.read(root, `canvas/jobs/${name}`);
        if (!file || file.contentEncoding !== "utf8") return [];
        const job = generationJob.parse(JSON.parse(file.content));
        return `${job.id}.json` === name ? [job] : [];
      } catch {
        return [];
      }
    }),
  );
  return jobs
    .flat()
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 100);
}

/** The board and document IDs the index names, read leniently: the server validates the index. */
function indexIds(file: CanvasFile | null) {
  const ids = (entries: unknown) =>
    Array.isArray(entries)
      ? entries.flatMap((entry: unknown) => {
          const id = (entry as { id?: unknown } | null)?.id;
          return typeof id === "string" && idPattern.test(id) ? [id] : [];
        })
      : [];
  try {
    const index = JSON.parse(file?.contentEncoding === "utf8" ? file.content : "null") as {
      boards?: unknown;
      documents?: unknown;
    } | null;
    return { valid: index !== null, boards: ids(index?.boards), documents: ids(index?.documents) };
  } catch {
    return { valid: false, boards: [], documents: [] };
  }
}

function entryHash(entry: CanvasEntry): string {
  if (entry.kind === "file") return `file:${entry.file.contentEncoding}:${entry.file.sha256}`;
  if (entry.kind === "oversized") return `oversized:${entry.sha256}`;
  if (entry.kind === "missing") return "missing";
  return sha256(JSON.stringify(entry));
}

function fingerprintOf(hashes: ReadonlyMap<string, string>): string {
  const hash = createHash("sha256");
  for (const key of [...hashes.keys()].sort()) hash.update(`${key}\0${hashes.get(key)}\n`);
  return hash.digest("hex");
}

/** What a studio may already hold: a file's new hash. Anything else only says it changed. */
function changesBetween(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
  entries: ReadonlyMap<string, CanvasEntry>,
): CanvasChange[] {
  const changes: CanvasChange[] = [];
  const name = (key: string) => (key.startsWith("file:") ? key.slice(5) : key);
  for (const [key, hash] of after) {
    if (before.get(key) === hash) continue;
    const entry = entries.get(key);
    changes.push({ path: name(key), sha256: entry?.kind === "file" ? entry.file.sha256 : null });
  }
  for (const key of before.keys())
    if (!after.has(key)) changes.push({ path: name(key), sha256: null });
  return changes;
}

type Watch = {
  gameId: string;
  root: string;
  kind: Game["kind"];
  until: number;
  /** Each entry's hash as the last check, or the read that armed the watch, saw it. */
  seen: ReadonlyMap<string, string>;
  folders: Map<string, Promise<ExperimentalHostWatchSubscription>>;
  queue: Promise<void>;
  checking: Promise<void> | null;
  timer: ReturnType<typeof setTimeout> | null;
  context: Context;
};
type Remembered = { fingerprint: string; hashes: ReadonlyMap<string, string> };

export class CanvasHost {
  private readonly disk: CanvasDisk;
  private readonly jobs: CanvasJobs;
  private readonly watches = new Map<string, Watch>();
  /** The last few answers per canvas, by hash only, so a read can send what changed since one. */
  private readonly answers = new Map<string, Remembered[]>();
  private readonly saves = new Map<string, Promise<unknown>>();
  private readonly partBytes: number;
  constructor(disk: CanvasDisk, jobs: CanvasJobs, { partBytes = PART_BYTES } = {}) {
    this.disk = disk;
    this.jobs = jobs;
    this.partBytes = partBytes;
  }

  /**
   * Every file and listing the server's workspace readers ask for
   * (`loadCanvas` in src/server/lib/studio.ts). The two lists are kept in
   * step by hand: a reader that asks for something not gathered here fails
   * with "The workspace read is missing …", and the server tests, which read
   * every workspace through this host, catch that. Add a path here with it.
   */
  private async gather(root: string, kind: Game["kind"]) {
    const entries = new Map<string, CanvasEntry>();
    const file = async (path: string, optional = false) => {
      let found: CanvasFile | null;
      try {
        found = await this.disk.read(root, path);
      } catch (error) {
        if (!optional) throw error;
        found = null;
      }
      entries.set(
        `file:${path}`,
        !found
          ? { kind: "missing" }
          : found.sizeBytes > MAX_FILE_BYTES
            ? { kind: "oversized", sha256: found.sha256, sizeBytes: found.sizeBytes }
            : { kind: "file", file: found },
      );
      return found;
    };
    const listing = async (folder: string) => {
      const found = await this.disk.list(root, folder, 10_000);
      entries.set(
        `list:${folder}`,
        found
          ? {
              kind: "listing",
              files: found.files.map((path) => `${folder}/${path}`),
              truncated: found.truncated,
            }
          : { kind: "missing" },
      );
      return found;
    };
    const requests = async () => {
      const found = await listing("canvas/requests");
      const names = (found?.files ?? []).filter((name) => recordPattern.test(name)).slice(0, 1000);
      // Each agent owns one request file. One still being written never hides the others.
      for (let at = 0; at < names.length; at += 50)
        await Promise.all(
          names.slice(at, at + 50).map((name) => file(`canvas/requests/${name}`, true)),
        );
    };
    const jobs = async () => {
      const { workspacePath, jobs: listed, stale } = await this.jobs(root);
      entries.set("jobs", { kind: "jobs", workspacePath, stale });
      for (const job of listed) entries.set(`job:${job.id}`, { kind: "job", job });
    };
    const ids = indexIds(await file("canvas/index.json"));
    await Promise.all([
      ...ids.boards.flatMap((id) => [
        file(`canvas/boards/${id}.json`),
        file(`canvas/editor/${id}.json`),
      ]),
      ...ids.documents.map((id) => file(`canvas/documents/${id}.md`)),
      file("canvas/assets.json"),
      file("canvas/evidence/index.json"),
      ...(kind === "unity" ? [file("ProjectSettings/ProjectVersion.txt")] : []),
      ...[...canvasAssetRoots(kind), "canvas/evidence"].map(listing),
      requests(),
      jobs(),
    ]);
    const hashes = new Map([...entries].map(([key, entry]) => [key, entryHash(entry)]));
    return { entries, hashes, fingerprint: fingerprintOf(hashes) };
  }

  private remembered(root: string, fingerprint: string) {
    return this.answers.get(root)?.find((answer) => answer.fingerprint === fingerprint);
  }

  private remember(root: string, answer: Remembered) {
    const kept = (this.answers.get(root) ?? []).filter(
      ({ fingerprint }) => fingerprint !== answer.fingerprint,
    );
    this.answers.delete(root);
    this.answers.set(root, [answer, ...kept].slice(0, 4));
    // Canvases nobody read lately go first.
    for (const key of this.answers.keys()) {
      if (this.answers.size <= 64) break;
      this.answers.delete(key);
    }
  }

  async read(
    input: {
      rootPath: string;
      kind: Game["kind"];
      since?: string | undefined;
      watch?: { gameId: string } | undefined;
    },
    context: Context,
  ): Promise<CanvasRead> {
    const { entries, hashes, fingerprint } = await this.gather(input.rootPath, input.kind);
    if (input.watch) {
      const jobs = entries.get("jobs");
      await this.keepWatching(input.rootPath, input.kind, input.watch.gameId, hashes, context, {
        jobsPath: jobs?.kind === "jobs" ? jobs.workspacePath : null,
      });
    }
    const base = input.since ? this.remembered(input.rootPath, input.since) : undefined;
    this.remember(input.rootPath, { fingerprint, hashes });
    if (input.since === fingerprint) return { status: "unchanged", fingerprint };
    const changed = [...entries].filter(([key]) => base?.hashes.get(key) !== hashes.get(key));
    const removed = base ? [...base.hashes.keys()].filter((key) => !hashes.has(key)) : [];
    const answer = { status: "changed" as const, base: base?.fingerprint ?? null, removed };
    const part = this.firstPart(changed);
    if (part.length === changed.length)
      return { ...answer, fingerprint, entries: Object.fromEntries(changed) };
    // The rest waits for the next read, which names the part the server now holds as its base.
    const held = new Map(base?.hashes);
    for (const key of removed) held.delete(key);
    for (const [key] of part) held.set(key, hashes.get(key)!);
    const partial = fingerprintOf(held);
    this.remember(input.rootPath, { fingerprint: partial, hashes: held });
    return { ...answer, fingerprint: partial, entries: Object.fromEntries(part), more: true };
  }

  /** The leading entries that fit one host result. The first always goes, so every part makes progress. */
  private firstPart(entries: [string, CanvasEntry][]) {
    let budget = this.partBytes;
    const part: [string, CanvasEntry][] = [];
    for (const [key, entry] of entries) {
      const size = key.length + Buffer.byteLength(JSON.stringify(entry));
      if (part.length && size > budget) continue;
      budget -= size;
      part.push([key, entry]);
    }
    return part;
  }

  /**
   * Compare-and-swap on the host: the board's content and layout must still be
   * the revision the studio edited. Layout goes first, so a late content
   * conflict never replaces external content.
   */
  async saveBoard(input: {
    rootPath: string;
    boardId: string;
    expected: { content: string; layout: string | null };
    content: string;
    layout: string;
  }) {
    return locked(this.saves, input.rootPath, async () => {
      const root = input.rootPath;
      const index = await this.disk.read(root, "canvas/index.json");
      if (!index)
        throw new Error(
          "canvas/index.json is missing from this game. Restore the file before reopening it.",
        );
      const ids = indexIds(index);
      if (!ids.valid) throw new Error("canvas/index.json is invalid.");
      if (!ids.boards.includes(input.boardId))
        throw new Error("This board is not registered in the workspace.");
      const contentPath = `canvas/boards/${input.boardId}.json`;
      const layoutPath = `canvas/editor/${input.boardId}.json`;
      const [content, layout] = await Promise.all([
        this.disk.read(root, contentPath),
        this.disk.read(root, layoutPath),
      ]);
      if (
        content?.sha256 !== input.expected.content ||
        (layout?.sha256 ?? null) !== input.expected.layout
      )
        throw new Error("This board changed on disk. Reload the workspace before saving again.");
      const write = async (path: string, text: string, expected: string | null) => {
        const written = await this.disk.write(root, path, text, "utf8", expected);
        if (written === null)
          throw new Error(
            `${path} changed on disk. Reload the workspace before saving again; your newer disk file was preserved.`,
          );
        return written;
      };
      const savedLayout = await write(layoutPath, input.layout, input.expected.layout);
      return {
        layout: savedLayout,
        content: await write(contentPath, input.content, input.expected.content),
      };
    });
  }

  /** Freezes selected image and model bytes as canvas/inputs/<sha>.<ext>, beside the project. */
  async captureInputs(input: { rootPath: string; paths: string[] }) {
    const inputs: { path: string; snapshot: string; sha256: string }[] = [];
    const written = new Set<string>();
    for (const path of new Set(input.paths)) {
      const file = await this.disk.read(input.rootPath, path);
      if (!file) throw new Error(`Path does not exist: ${path}`);
      const snapshot = `canvas/inputs/${file.sha256}.${inputExtension(path, file)}`;
      if (!written.has(snapshot)) {
        const created = await this.disk.write(
          input.rootPath,
          snapshot,
          file.content,
          file.contentEncoding,
          null,
        );
        if (created === null) {
          const existing = await this.disk.read(input.rootPath, snapshot);
          if (existing?.sha256 !== file.sha256)
            throw new Error("A saved generation input changed. No request was submitted.");
        }
        written.add(snapshot);
      }
      inputs.push({ path, snapshot, sha256: file.sha256 });
    }
    return { inputs };
  }

  /**
   * Keeps the canvas watched for LEASE_MS more. A new watch starts from what
   * this read saw. An old one keeps its own baseline, so a change that landed
   * during the read is still said to the studios that did not read it.
   */
  private async keepWatching(
    root: string,
    kind: Game["kind"],
    gameId: string,
    hashes: ReadonlyMap<string, string>,
    context: Context,
    { jobsPath }: { jobsPath: string | null },
  ) {
    let watch = this.watches.get(root);
    if (watch && (watch.gameId !== gameId || watch.kind !== kind)) {
      this.stop(watch);
      watch = undefined;
    }
    if (!watch) {
      watch = {
        gameId,
        root,
        kind,
        until: 0,
        seen: hashes,
        folders: new Map(),
        queue: Promise.resolve(),
        checking: null,
        timer: null,
        context,
      };
      this.watches.set(root, watch);
    }
    watch.until = Date.now() + LEASE_MS;
    this.expire(watch);
    const folders: [string, string][] = [
      [root, "canvas"],
      ...canvasAssetRoots(kind)
        .filter((folder) => !folder.startsWith("canvas/"))
        .map((folder): [string, string] => [root, folder]),
      // The runner keeps jobs in the checkout it resolved, which can differ from the game's path.
      ...(jobsPath && jobsPath !== root ? [[jobsPath, "canvas/jobs"] as [string, string]] : []),
    ];
    // A folder made since the last read is watched from this one on.
    for (const [base, folder] of folders) {
      const key = projectFile(base, folder);
      if (watch.folders.has(key) || !(await this.disk.directory(base, folder))) continue;
      // Another read may have armed this folder, or ended this watch, while we looked.
      if (watch.folders.has(key) || this.watches.get(root) !== watch) continue;
      const current = watch;
      const subscription = Promise.resolve().then(() =>
        context.experimental_watch(
          {
            rootPath: key,
            // Input snapshots are written while dispatching; no workspace entry reads them.
            ignoredPaths: folder === "canvas" ? ["inputs"] : [],
            debounceMs: DEBOUNCE_MS,
            maxWaitMs: MAX_WAIT_MS,
          },
          (event) => this.changed(current, key, event),
        ),
      );
      watch.folders.set(key, subscription);
      // A watch that cannot start leaves the studio on its safety poll; the next read tries again.
      // One that starts looks once more: a write before it went live made no event.
      subscription.then(
        () => this.changed(current, key, { kind: "rescan-required" }),
        () => {
          if (current.folders.get(key) === subscription) current.folders.delete(key);
        },
      );
    }
  }

  private changed(watch: Watch, folder: string, event: ExperimentalHostWatchEvent) {
    if (this.watches.get(watch.root) !== watch) return;
    if (event.kind === "watch-error") {
      // A broken folder watch goes, and the next read arms a new one.
      const subscription = watch.folders.get(folder);
      watch.folders.delete(folder);
      void subscription?.then((value) => value.dispose()).catch(() => undefined);
    }
    // Checks run one at a time, and a check not yet started covers every event before it.
    if (watch.checking) return;
    const previous = watch.queue;
    const check = (async () => {
      await previous;
      watch.checking = null;
      if (this.watches.get(watch.root) !== watch) return;
      const { entries, hashes } = await this.gather(watch.root, watch.kind);
      const changes = changesBetween(watch.seen, hashes, entries);
      watch.seen = hashes;
      if (!changes.length) return;
      await watch.context.experimental_emitSignal("canvasChanged", {
        gameId: watch.gameId,
        changes: changes.length > changeLimit ? null : changes,
      });
    })();
    watch.checking = check;
    watch.queue = check.catch(() => undefined);
  }

  private expire(watch: Watch) {
    if (watch.timer) clearTimeout(watch.timer);
    watch.timer = setTimeout(
      () => {
        if (Date.now() >= watch.until) this.stop(watch);
        else this.expire(watch);
      },
      Math.max(0, watch.until - Date.now()),
    );
    watch.timer.unref?.();
  }

  private stop(watch: Watch) {
    if (this.watches.get(watch.root) === watch) this.watches.delete(watch.root);
    if (watch.timer) clearTimeout(watch.timer);
    for (const subscription of watch.folders.values())
      void subscription.then((value) => value.dispose()).catch(() => undefined);
    watch.folders.clear();
  }

  dispose() {
    for (const watch of this.watches.values()) this.stop(watch);
  }
}
