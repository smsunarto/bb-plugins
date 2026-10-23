import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

/*
 * Each checkout's staged media and input snapshots live in a folder of their own, in Game
 * Studio's host data directory: `<dataDir>/media/<id>/{staging,inputs}`. The checkout names
 * its folder in `canvas/staging/.moved`, with the identity (device and inode) of the checkout
 * folder that moved. A renamed checkout keeps both, so it keeps its folder; a new checkout at
 * the same path has no `.moved` and starts its own. A copy carries a `.moved` naming another
 * folder's identity: it writes in its own `canvas` until its first collection forks the
 * original's folder into one of its own, so no two checkouts ever write or free one folder.
 *
 * A move first records the folder in `.moved`, then copies every file, recording each version
 * it copied in `copied.json`, then writes `owner.json`, which is the switch, then marks
 * `.moved` switched. The old copies stay LEGACY_GRACE_MS for readers that resolved the old
 * folder. A file there that is not a recorded copy, such as one an agent told the old path
 * wrote after the move began, moves in when the media folder lacks it or still holds the
 * recorded copy, and otherwise stays where it is: nothing unrecorded is deleted or written over.
 */

/** How long a moved checkout keeps its old copies, for readers that resolved them before. */
export const LEGACY_GRACE_MS = 24 * 3_600_000;
/**
 * How long one collection moves files before it stops and frees space; the next one goes on
 * from there. Well within the server's call deadline.
 */
const MOVE_BUDGET_MS = 45_000;
const OWNER = "owner.json";
const COPIED = "copied.json";
const MOVED = ".moved";
/** The note left in the old folder for agents and people looking there. */
export const MOVED_NOTE = "MOVED.md";
const areas = ["staging", "inputs"] as const;

export type MediaState =
  /** The checkout keeps its media in its own `canvas` folder. */
  | { kind: "legacy"; root: string; dir: string }
  | { kind: "moved"; root: string; dir: string; movedAt: number }
  /**
   * A copy of a moved checkout, until its collection forks the folder. It writes in its own
   * `canvas`; the media it was copied with stay in the original's folder until the fork.
   */
  | { kind: "copied"; root: string; dir: string; from: string }
  /**
   * Moved, but its folder is gone. Runs write in the checkout again and nothing is collected,
   * so the catalog keeps its entries until the folder returns or `.moved` is deleted.
   */
  | { kind: "lost"; root: string; dir: string };
type Moved = Extract<MediaState, { kind: "moved" }>;

/** `from`: the folder a copy forks, while its move is pending. */
type Marker = { id: string; switched: boolean; identity: string; from?: string };
type Owner = { version: 2; id: string; rootPath: string; movedAt: number };
/** Each copied file's size and modification time, by media-relative path. */
type Copied = Record<string, [number, number]>;
type Gate = { readers: Set<Promise<unknown>>; writer: Promise<unknown> | null };

const code = (error: unknown) =>
  error instanceof Error && "code" in error ? (error as { code: unknown }).code : undefined;

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (code(error) === "ENOENT" || code(error) === "ENOTDIR" || error instanceof SyntaxError)
      return null;
    throw error;
  }
}

const version = async (path: string) => {
  const entry = await stat(path).catch(() => null);
  return entry?.isFile() ? ([entry.size, entry.mtimeMs] as [number, number]) : null;
};
const same = (a: [number, number] | null | undefined, b: [number, number] | null | undefined) =>
  !!a && !!b && a[0] === b[0] && a[1] === b[1];

async function digest(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Writes a file whole: a reader sees the old content or the new, never part. */
async function publish(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { flag: "wx" });
  await rename(temporary, path);
}

/** Copies a file, as a clone where the filesystem can, keeping its modification time. */
async function cloneFile(from: string, to: string) {
  const source = await stat(from);
  await mkdir(dirname(to), { recursive: true });
  const temporary = `${to}.${randomUUID()}.tmp`;
  await copyFile(from, temporary, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
  try {
    const copied = await stat(temporary);
    if (copied.size !== source.size || (await stat(from)).mtimeMs !== source.mtimeMs)
      throw new Error(`${from} changed while it was copied.`);
    await utimes(temporary, source.atime, source.mtime);
    await rename(temporary, to);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

/** Moves a file, over any there, copying across filesystems, and keeps its modification time. */
async function moveFile(from: string, to: string) {
  await mkdir(dirname(to), { recursive: true });
  try {
    await rename(from, to);
  } catch (error) {
    if (code(error) !== "EXDEV") throw error;
    await cloneFile(from, to);
    await unlink(from);
  }
}

/** Every file below a folder, relative to it; symbolic links and crash leftovers are skipped. */
async function files(folder: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, prefix: string) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (code(error) === "ENOENT" || code(error) === "ENOTDIR") return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || entry.name.startsWith(".freed-") || entry.name.endsWith(".tmp"))
        continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(dir, entry.name), relative);
      else if (entry.isFile()) found.push(relative);
    }
  };
  await walk(folder, "");
  return found;
}

/** Removes the empty folders below `folder`, deepest first, keeping `folder` itself. */
async function prune(folder: string) {
  let entries;
  try {
    entries = await readdir(folder, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries)
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      const path = join(folder, entry.name);
      await prune(path);
      await rmdir(path).catch(() => undefined);
    }
}

/** The files a move takes: everything below the checkout's old media areas but the markers. */
async function legacyFiles(root: string, below = "") {
  const found: string[] = [];
  for (const area of areas) {
    if (below && !below.startsWith(`${area}/`)) continue;
    const folder = below || area;
    for (const file of await files(join(root, "canvas", ...folder.split("/"))))
      if (!(folder === "staging" && (file === MOVED || file === MOVED_NOTE)))
        found.push(`${folder}/${file}`);
  }
  return found;
}

/**
 * One file of a moved checkout's old folder. A recorded copy goes once readers had their
 * time, as does a file the media folder holds the same bytes of. Any other file is a newer
 * write: it moves in where the media folder has none or still has the recorded copy, which it
 * replaces, and otherwise stays, never deleted or written over. True when it replaced a copy.
 */
async function settleFile(state: Moved, copied: Copied, path: string, expired: boolean) {
  const source = join(state.root, "canvas", ...path.split("/"));
  const legacy = await version(source);
  if (!legacy) return false;
  if (same(legacy, copied[path])) {
    if (expired) await unlink(source);
    return false;
  }
  const target = join(state.dir, ...path.split("/"));
  const current = await version(target);
  // Saved again in the old folder, as by an agent keeping its path.
  const stale = same(current, copied[path]);
  if (!current || stale) {
    await moveFile(source, target);
    return stale;
  }
  if (expired && current[0] === legacy[0] && (await digest(source)) === (await digest(target)))
    await unlink(source);
  return false;
}

const isId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{32}$/.test(value);

/** What a rename of the checkout keeps and a copy does not: its folder's device and inode. */
async function identity(root: string) {
  const entry = await stat(root, { bigint: true });
  return `${entry.dev}:${entry.ino}`;
}

/** Where a pass stops: past its deadline, or when its call is cancelled. */
type Budget = { signal?: AbortSignal; deadline?: number; now: () => number };
const over = ({ signal, deadline, now }: Budget) => {
  signal?.throwIfAborted();
  return deadline !== undefined && now() > deadline;
};

export class Media {
  private dataDir: string | null;
  private readonly gates = new Map<string, Gate>();
  constructor(dataDir: string | null = null) {
    this.dataDir = dataDir;
  }
  /** The host data directory, known from the first call that carries it. */
  use(dataDir: string) {
    this.dataDir ??= dataDir;
    return this;
  }

  private folder(id: string) {
    return join(this.dataDir!, "media", id);
  }
  private async owner(dir: string): Promise<Owner | null> {
    const value = (await readJson(join(dir, OWNER))) as Partial<Owner> | null;
    return value?.version === 2 &&
      typeof value.id === "string" &&
      typeof value.rootPath === "string" &&
      typeof value.movedAt === "number"
      ? (value as Owner)
      : null;
  }
  private async copied(dir: string): Promise<Copied> {
    const value = await readJson(join(dir, COPIED));
    return value && typeof value === "object" ? (value as Copied) : {};
  }
  /** The media folder a checkout names, and whether its move finished. */
  async marker(root: string): Promise<Marker | null> {
    const value = (await readJson(
      join(root, "canvas", "staging", MOVED),
    )) as Partial<Marker> | null;
    if (!isId(value?.id) || typeof value.identity !== "string") return null;
    const marker: Marker = {
      id: value.id,
      switched: value.switched === true,
      identity: value.identity,
    };
    return isId(value.from) ? { ...marker, from: value.from } : marker;
  }
  private async mark(root: string, marker: Marker) {
    await publish(join(root, "canvas", "staging", MOVED), `${JSON.stringify(marker)}\n`);
  }

  /** Where a checkout's media lives now. */
  async state(rootPath: string): Promise<MediaState> {
    const root = await realpath(rootPath);
    const legacy: MediaState = { kind: "legacy", root, dir: join(root, "canvas") };
    if (!this.dataDir) return legacy;
    const marker = await this.marker(root);
    if (!marker) return legacy;
    const dir = this.folder(marker.id);
    const owner = await this.owner(dir);
    const switched = owner?.id === marker.id;
    // Switched, though `.moved` may not say so yet after a crash.
    if (switched && marker.identity === (await identity(root)))
      return { kind: "moved", root, dir, movedAt: owner.movedAt };
    if (!marker.switched) {
      // A move that has not switched: the media are in the checkout, but for a fork's.
      if (!marker.from) return legacy;
      return (await this.owner(this.folder(marker.from)))?.id === marker.from
        ? { kind: "copied", root, dir: legacy.dir, from: marker.from }
        : { kind: "lost", root, dir: legacy.dir };
    }
    // A copy of a moved checkout, unless the folder is gone.
    return switched
      ? { kind: "copied", root, dir: legacy.dir, from: marker.id }
      : { kind: "lost", root, dir: legacy.dir };
  }

  /** The checkout's media folder, as `canvas/` paths map to it. */
  async dir(rootPath: string) {
    return (await this.state(rootPath)).dir;
  }

  private gate(key: string) {
    let gate = this.gates.get(key);
    if (!gate) {
      gate = { readers: new Set(), writer: null };
      this.gates.set(key, gate);
    }
    return gate;
  }
  private release(key: string, gate: Gate) {
    if (!gate.readers.size && !gate.writer && this.gates.get(key) === gate) this.gates.delete(key);
  }
  /**
   * Work that resolves the media folder and uses it, which a switch waits for. Never nest it:
   * a switch waiting on the outer call would hold up the inner one.
   */
  async shared<T>(rootPath: string, work: () => Promise<T>): Promise<T> {
    const key = await realpath(rootPath);
    for (;;) {
      const writer = this.gate(key).writer;
      if (!writer) break;
      await writer.catch(() => undefined);
    }
    const gate = this.gate(key);
    const run = work();
    gate.readers.add(run);
    try {
      return await run;
    } finally {
      gate.readers.delete(run);
      this.release(key, gate);
    }
  }
  private async exclusive<T>(root: string, work: () => Promise<T>): Promise<T> {
    for (;;) {
      const writer = this.gate(root).writer;
      if (!writer) break;
      await writer.catch(() => undefined);
    }
    const gate = this.gate(root);
    const run = (async () => {
      await Promise.allSettled(gate.readers);
      return work();
    })();
    gate.writer = run;
    try {
      return await run;
    } finally {
      if (gate.writer === run) gate.writer = null;
      this.release(root, gate);
    }
  }

  /**
   * Moves a checkout's media to its own folder, forks the folder a copy was copied with, or
   * settles stragglers of an earlier move. The copy runs first without holding up runs, for at
   * most `budgetMs`; the switch waits for runs in flight and happens only while `busy` says
   * nothing may still write where it was told to.
   */
  async migrate(rootPath: string, options: Migration): Promise<MediaState> {
    const { busy, note, signal, now = Date.now, budgetMs = MOVE_BUDGET_MS } = options;
    const budget: Budget = { now, deadline: now() + budgetMs, ...(signal ? { signal } : {}) };
    const state = await this.state(rootPath);
    if (!this.dataDir || state.kind === "lost") return state;
    if (state.kind === "moved") {
      await this.finish(state, note);
      if (!(await busy())) await this.settle(state, now(), budget);
      return state;
    }
    if (await busy()) return state;
    const mine = await identity(state.root);
    const recorded = await this.marker(state.root);
    // A pending move of this checkout goes on; a copy, of a moved checkout or of one whose move
    // was pending, starts its own.
    const marker: Marker =
      recorded && !recorded.switched && recorded.identity === mine
        ? recorded
        : {
            id: randomUUID().replaceAll("-", ""),
            switched: false,
            identity: mine,
            ...(state.kind === "copied" ? { from: state.from } : {}),
          };
    if (marker !== recorded) await this.mark(state.root, marker);
    const dir = this.folder(marker.id);
    if (!(await this.copy(state.root, dir, marker.from, budget))) return this.state(state.root);
    const switched = await this.exclusive(state.root, async () => {
      const current = await this.state(state.root);
      if (current.kind === "moved" || current.kind === "lost" || (await busy())) return current;
      // Only what changed since the first pass is copied while runs wait.
      await this.copy(state.root, dir, marker.from, { now, ...(signal ? { signal } : {}) });
      const owner: Owner = { version: 2, id: marker.id, rootPath: state.root, movedAt: now() };
      await publish(join(dir, OWNER), `${JSON.stringify(owner)}\n`);
      return this.state(state.root);
    });
    if (switched.kind === "moved") await this.finish(switched, note);
    return switched;
  }

  /**
   * Copies each old-folder file whose current version the media folder lacks, recording each
   * as it goes so a pass that stops keeps its progress; for a fork, first the files of the
   * folder it forks that the old folder has none of. False when the pass ran out of time.
   */
  private async copy(root: string, dir: string, from: string | undefined, budget: Budget) {
    const legacy = await legacyFiles(root);
    if (from && !(await this.fork(this.folder(from), dir, new Set(legacy), budget))) return false;
    const copied = await this.copied(dir);
    const save = () => publish(join(dir, COPIED), `${JSON.stringify(copied)}\n`);
    let unsaved = 0;
    try {
      for (const path of legacy) {
        if (over(budget)) return false;
        const source = join(root, "canvas", ...path.split("/"));
        const target = join(dir, ...path.split("/"));
        const current = await version(source);
        if (!current) continue;
        if (!same(current, copied[path]) || !same(current, await version(target)))
          await cloneFile(source, target);
        copied[path] = current;
        if (++unsaved >= 50) {
          await save();
          unsaved = 0;
        }
      }
      return true;
    } finally {
      if (unsaved) await save();
    }
  }

  /** Copies another checkout's media into a fork, as it is now; it is never written. */
  private async fork(source: string, dir: string, own: Set<string>, budget: Budget) {
    for (const area of areas)
      for (const file of await files(join(source, area))) {
        if (over(budget)) return false;
        const path = `${area}/${file}`;
        const from = join(source, area, ...file.split("/"));
        const to = join(dir, area, ...file.split("/"));
        if (own.has(path) || same(await version(from), await version(to))) continue;
        // One the original freed while this ran.
        await cloneFile(from, to).catch((error: unknown) => {
          if (code(error) !== "ENOENT") throw error;
        });
      }
    return true;
  }

  /** Marks the move switched and leaves the note, repairing either after a crash. */
  private async finish(state: Moved, note: string) {
    const marker = await this.marker(state.root);
    if (marker && !marker.switched) await this.mark(state.root, { ...marker, switched: true });
    // A renamed checkout's folder names where it is now.
    const owner = await this.owner(state.dir);
    if (owner && owner.rootPath !== state.root)
      await publish(
        join(state.dir, OWNER),
        `${JSON.stringify({ ...owner, rootPath: state.root } satisfies Owner)}\n`,
      );
    const path = join(state.root, "canvas", "staging", MOVED_NOTE);
    const text = note.replaceAll("{{mediaDir}}", state.dir);
    if ((await readFile(path, "utf8").catch(() => null)) !== text) await publish(path, text);
  }

  /**
   * Settles a moved checkout's old folder: a file that is not a recorded copy moves in, and
   * recorded copies go once readers had LEGACY_GRACE_MS to finish with them.
   */
  private async settle(state: Moved, at: number, budget: Budget) {
    const expired = at - state.movedAt >= LEGACY_GRACE_MS;
    if (!(await this.settleFiles(state, await legacyFiles(state.root), expired, budget))) return;
    for (const area of areas) {
      const legacy = join(state.root, "canvas", area);
      await prune(legacy);
      // Crash leftovers of collection in the old folder.
      for (const name of await readdir(legacy).catch(() => [] as string[]))
        if (name.startsWith(".freed-"))
          await rm(join(legacy, name), { recursive: true, force: true });
    }
  }

  /**
   * Moves a run's files that landed in the old folder, as an agent told the old path writes
   * them, into the media folder where it has none. Call it within `shared`.
   */
  async stragglers(rootPath: string, folder: string) {
    const state = await this.state(rootPath);
    if (state.kind !== "moved") return;
    await this.settleFiles(state, await legacyFiles(state.root, folder), false, {
      now: Date.now,
    });
  }

  /** Settles old-folder files, keeping `copied.json` in step. False when out of time. */
  private async settleFiles(state: Moved, paths: string[], expired: boolean, budget: Budget) {
    const copied = await this.copied(state.dir);
    let replaced = false;
    try {
      for (const path of paths) {
        if (over(budget)) return false;
        if (await settleFile(state, copied, path, expired)) {
          // The media folder's file is now the newer write, which no copy stands for.
          delete copied[path];
          replaced = true;
        }
      }
      return true;
    } finally {
      if (replaced) await publish(join(state.dir, COPIED), `${JSON.stringify(copied)}\n`);
    }
  }
}

export type Migration = {
  /** Whether a run may still write where it was told to: the move waits for it. */
  busy: () => Promise<boolean>;
  /** The note left in the old folder; `{{mediaDir}}` names the new one. */
  note: string;
  signal?: AbortSignal;
  now?: () => number;
  /** How long this pass moves files before it stops; the next goes on from there. */
  budgetMs?: number;
};
