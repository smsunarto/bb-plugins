import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  Attribution,
  CaptureKind,
  Pin,
  SnapshotPatch,
  TurnWindow,
} from "../shared/host-contract.ts";

/**
 * Workspace snapshots, T3 Code style: each capture writes the checkout's files
 * into a commit through a throwaway index and pins it under a private ref.
 * A turn's diff is the tree diff between the captures bracketing it.
 *
 * GitButler keeps the real index, HEAD, and `refs/heads` busy, so none of
 * them are touched. Tree-to-tree diffs also survive `but commit`, `but
 * absorb`, and workspace-commit rewrites during the turn: moving changes into
 * commits leaves the working tree, and so the snapshot, unchanged.
 *
 * Ref layout: `refs/bb-last-turn/<checkout>/<thread>/<at>-<finishedAt>-<kind>`.
 * `checkout` hashes the worktree root, so linked worktrees sharing one ref
 * store never see each other's captures. `at` and `finishedAt` are the
 * server's clock, which also stamps turn events, around the snapshot call:
 * the files were read somewhere in between. Wall clocks only order captures
 * against bb's turn boundaries. What a capture proves about a turn comes from
 * the server's per-thread ordering, recorded in its kind.
 */
const NAMESPACE = "refs/bb-last-turn";
/** Captures always retained per thread, however old: the last several turns. */
const KEEP = 24;
/**
 * An `open` with no `end` this old came from a lost capture, not a running
 * turn. Captures this recent are kept as evidence for overlapping turns.
 */
const MAX_TURN_MS = 6 * 60 * 60 * 1000;
/**
 * Linked worktrees share one ref store, and a removed worktree never pins
 * again to prune its own namespace. Its captures this old are swept.
 */
const MAX_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PATCH_BYTES = 1_000_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const IDENTITY = {
  GIT_AUTHOR_NAME: "bb last-turn-diff",
  GIT_AUTHOR_EMAIL: "last-turn-diff@bb.invalid",
  GIT_COMMITTER_NAME: "bb last-turn-diff",
  GIT_COMMITTER_EMAIL: "last-turn-diff@bb.invalid",
};
/** User diff settings that would change the patch shape the viewer parses. */
const DIFF_CONFIG = [
  "-c",
  "diff.noprefix=false",
  "-c",
  "diff.mnemonicPrefix=false",
  "-c",
  "diff.relative=false",
  "-c",
  "diff.submodule=short",
  "-c",
  "core.quotePath=false",
];
// Never take optional locks on the real index GitButler also writes.
const BASE_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };

/** `gone` marks a forgotten thread whose recent captures are kept as evidence. */
type Kind = CaptureKind | "gone";
interface Capture {
  ref: string;
  commit: string;
  tree: string;
  /** The hashed worktree root whose namespace holds the ref. */
  checkout: string;
  threadId: string;
  at: number;
  finishedAt: number;
  kind: Kind;
}

/** Kinds whose commit is the checkout as of `at`, so they may bound a diff. */
function isSnapshot(capture: Capture): boolean {
  return capture.kind === "start" || capture.kind === "open" || capture.kind === "end";
}

function refName({ at, finishedAt, kind }: { at: number; finishedAt: number; kind: Kind }) {
  return `${String(at).padStart(15, "0")}-${String(finishedAt).padStart(15, "0")}-${kind}`;
}

function git(
  cwd: string,
  args: readonly string[],
  signal: AbortSignal,
  env: Record<string, string> = {},
  input?: string | Buffer,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      args,
      {
        cwd,
        encoding: "utf8",
        maxBuffer: MAX_OUTPUT_BYTES,
        signal,
        windowsHide: true,
        env: { ...process.env, ...BASE_ENV, ...env },
      },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || error.message));
        else resolve(stdout);
      },
    );
    // Git may exit without reading stdin. Its exit status reports real
    // failures, so an EPIPE here must not crash the host worker.
    child.stdin?.on("error", () => {});
    child.stdin?.end(input ?? "");
  });
}

/** Like `git`, but stops reading at `limit` bytes and answers null instead. */
function gitCapped(
  cwd: string,
  args: readonly string[],
  limit: number,
  signal: AbortSignal,
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      signal,
      windowsHide: true,
      env: { ...process.env, ...BASE_ENV },
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        overflow = true;
        child.kill();
      } else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (overflow) resolve(null);
      else if (code === 0) resolve(Buffer.concat(chunks).toString("utf8"));
      else reject(new Error(stderr.trim() || `git exited ${code}`));
    });
  });
}

/**
 * Run git, handing each NUL-separated stdout field to `take` as it arrives.
 * Fields stay raw bytes: Git paths need not be UTF-8.
 */
function gitFields(
  cwd: string,
  args: readonly string[],
  signal: AbortSignal,
  take: (field: Buffer) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      signal,
      windowsHide: true,
      env: { ...process.env, ...BASE_ENV },
    });
    let rest = Buffer.alloc(0);
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      let data = Buffer.concat([rest, chunk]);
      for (let end = data.indexOf(0); end !== -1; end = data.indexOf(0)) {
        take(data.subarray(0, end));
        data = data.subarray(end + 1);
      }
      rest = data;
    });
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `git exited ${code}`));
    });
  });
}

interface Checkout {
  top: string;
  /** The environment path relative to `top`, with a trailing slash, or "". */
  prefix: string;
  refPrefix: string;
  key: string;
}

function checkoutKey(top: string): string {
  return createHash("sha256").update(top).digest("hex").slice(0, 16);
}

/** Namespace keys of every worktree Git still knows, under each spelling of its path. */
async function worktreeKeys(target: Checkout, signal: AbortSignal): Promise<Set<string>> {
  const out = await git(target.top, ["worktree", "list", "--porcelain", "-z"], signal);
  const paths = out
    .split("\0")
    .filter((field) => field.startsWith("worktree "))
    .map((field) => field.slice("worktree ".length));
  const resolved = await Promise.all(paths.map((path) => realpath(path).catch(() => path)));
  return new Set([target.key, ...[...paths, ...resolved].map(checkoutKey)]);
}

async function checkout(path: string, signal: AbortSignal): Promise<Checkout | null> {
  let out: string;
  try {
    out = await git(path, ["rev-parse", "--show-toplevel", "--show-prefix"], signal);
  } catch {
    return null; // Not a git checkout: nothing to snapshot.
  }
  const [top = "", prefix = ""] = out.split("\n");
  const key = checkoutKey(top);
  return { top, prefix, key, refPrefix: `${NAMESPACE}/${key}/` };
}

function threadPrefix(target: Checkout, threadId: string): string {
  return `${target.refPrefix}${threadId}/`;
}

/** Every ref under `prefix`, parsed when it is a capture. */
async function listRefs(target: Checkout, prefix: string, signal: AbortSignal) {
  const out = await git(
    target.top,
    ["for-each-ref", "--format=%(refname) %(objectname) %(tree)", prefix],
    signal,
  );
  const refs: string[] = [];
  const captures: Capture[] = [];
  for (const line of out.split("\n")) {
    const [ref, commit, tree] = line.split(" ");
    if (!ref || !commit || !tree) continue;
    refs.push(ref);
    const match = ref
      .slice(NAMESPACE.length + 1)
      .match(/^([^/]+)\/([^/]+)\/(\d+)-(\d+)-(start|open|run|end|stop|gone)$/);
    if (!match) continue;
    captures.push({
      ref,
      commit,
      tree,
      checkout: match[1]!,
      threadId: match[2]!,
      at: Number(match[3]),
      finishedAt: Number(match[4]),
      kind: match[5] as Kind,
    });
  }
  return { refs, captures: captures.sort((a, b) => a.at - b.at) };
}

/**
 * Seed the private index from the real one so unchanged files keep their stat
 * cache, then drop the flags that tell `git add` to look away. A file marked
 * assume-unchanged can still change on disk, and so can a skip-worktree file
 * that is present. An absent skip-worktree file is outside a sparse checkout:
 * it keeps its flag, so the snapshot keeps its committed content.
 */
async function seedIndex(target: Checkout, env: { GIT_INDEX_FILE: string }, signal: AbortSignal) {
  const real = (
    await git(target.top, ["rev-parse", "--path-format=absolute", "--git-path", "index"], signal)
  ).trim();
  const copied = await copyFile(real, env.GIT_INDEX_FILE).then(
    () => true,
    () => false,
  );
  if (!copied) return;
  const assumed: string[] = [];
  const skipped: string[] = [];
  for (const entry of (await git(target.top, ["ls-files", "-z", "-v"], signal, env)).split("\0")) {
    const tag = entry[0];
    const path = entry.slice(2);
    if (!tag || !path) continue;
    if (tag !== tag.toUpperCase()) assumed.push(path);
    if (tag.toUpperCase() === "S") skipped.push(path);
  }
  const present = await Promise.all(
    skipped.map((path) =>
      lstat(join(target.top, path)).then(
        () => true,
        () => false,
      ),
    ),
  );
  for (const [flag, paths] of [
    ["--no-assume-unchanged", assumed],
    ["--no-skip-worktree", skipped.filter((_, i) => present[i])],
  ] as const) {
    if (paths.length === 0) continue;
    await git(target.top, ["update-index", "-z", flag, "--stdin"], signal, env, paths.join("\0"));
  }
}

/**
 * Record the checkout's current files, including untracked, non-ignored ones,
 * as a commit. Pins nothing: the server pins it once it knows what it proves.
 * Unreachable, it survives until `gc` prunes objects weeks old.
 */
export async function snapshot(environmentPath: string, signal: AbortSignal) {
  const target = await checkout(environmentPath, signal);
  if (!target) return null;
  const scratch = await mkdtemp(join(tmpdir(), "bb-last-turn-"));
  try {
    const env = { GIT_INDEX_FILE: join(scratch, "index") };
    await seedIndex(target, env, signal);
    const sparse = await git(target.top, ["config", "--bool", "core.sparseCheckout"], signal)
      .then((value) => value.trim() === "true")
      .catch(() => false);
    // fsmonitor state belongs to the real index; a full stat walk is exact.
    await git(
      target.top,
      ["-c", "core.fsmonitor=false", "add", "--all", ...(sparse ? ["--sparse"] : []), "--", "."],
      signal,
      env,
    );
    const tree = (await git(target.top, ["write-tree"], signal, env)).trim();
    const date = `@${Math.floor(Date.now() / 1000)} +0000`;
    return (
      await git(target.top, ["commit-tree", tree, "-m", "bb last-turn snapshot"], signal, {
        ...IDENTITY,
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
      })
    ).trim();
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Pin snapshots under the thread's refs. A `stop` without a commit points at
 * the thread's latest snapshot; it only records that the thread finished.
 */
export async function pin(
  environmentPath: string,
  threadId: string,
  pins: readonly Pin[],
  signal: AbortSignal,
): Promise<void> {
  const target = await checkout(environmentPath, signal);
  if (!target) return;
  const prefix = threadPrefix(target, threadId);
  const { captures } = await listRefs(target, target.refPrefix, signal);
  const mine = captures.filter((capture) => capture.threadId === threadId);
  const latest = mine.findLast(isSnapshot)?.commit;
  const lines: string[] = [];
  for (const capture of pins) {
    const commit = capture.commit ?? latest;
    if (commit) lines.push(`update ${prefix}${refName(capture)} ${commit}\n`);
  }
  // Capturing again revives a thread that came back from the archive.
  const gone = mine.filter((capture) => capture.kind === "gone");
  lines.push(...gone.map((capture) => `delete ${capture.ref}\n`));
  if (lines.length > 0)
    await git(target.top, ["update-ref", "--stdin"], signal, {}, lines.join(""));
  const now = Math.max(...pins.map((capture) => capture.finishedAt));
  // Pruning races other threads' pruning on packed-refs; the next pin retries.
  await Promise.all([listRefs(target, `${NAMESPACE}/`, signal), worktreeKeys(target, signal)])
    .then(([{ captures }, live]) => deleteRefs(target, stale(captures, live, now), signal))
    .catch(() => undefined);
}

/**
 * Captures no turn can still need: older than any turn's window, beyond each
 * live thread's latest few. A forgotten thread keeps only recent ones. A
 * removed worktree's captures go once they idle long enough.
 */
function stale(captures: Capture[], live: ReadonlySet<string>, now: number): string[] {
  const horizon = now - MAX_TURN_MS;
  const threads = new Map<string, Capture[]>();
  for (const capture of captures) {
    const key = `${capture.checkout}/${capture.threadId}`;
    threads.set(key, [...(threads.get(key) ?? []), capture]);
  }
  const refs: string[] = [];
  for (const list of threads.values()) {
    const gone = list.at(-1)?.kind === "gone";
    for (const [i, capture] of list.entries()) {
      const old = live.has(capture.checkout)
        ? capture.at < horizon && (gone || i < list.length - KEEP)
        : capture.at < now - MAX_IDLE_MS;
      if (old) refs.push(capture.ref);
    }
  }
  return refs;
}

async function deleteRefs(target: Checkout, refs: string[], signal: AbortSignal) {
  if (refs.length === 0) return;
  const input = refs.map((ref) => `delete ${ref}\n`).join("");
  await git(target.top, ["update-ref", "--stdin"], signal, {}, input);
}

/**
 * Drop the thread's refs. Captures recent enough to bound another thread's
 * running turn stay behind a `gone` marker until pruning ages them out.
 */
export async function forget(
  environmentPath: string,
  threadId: string,
  at: number,
  signal: AbortSignal,
): Promise<void> {
  const target = await checkout(environmentPath, signal);
  if (!target) return;
  const prefix = threadPrefix(target, threadId);
  const { refs, captures } = await listRefs(target, prefix, signal);
  // Lifecycle markers stay too: a dropped `stop` would make the thread look mid-turn.
  const kept = captures.filter(
    (capture) => capture.at >= at - MAX_TURN_MS && capture.kind !== "gone",
  );
  const lines = refs
    .filter((ref) => !kept.some((capture) => capture.ref === ref))
    .map((ref) => `delete ${ref}\n`);
  const latest = kept.findLast(isSnapshot) ?? kept.at(-1);
  if (latest) {
    lines.push(
      `update ${prefix}${refName({ at, finishedAt: at, kind: "gone" })} ${latest.commit}\n`,
    );
  }
  if (lines.length > 0)
    await git(target.top, ["update-ref", "--stdin"], signal, {}, lines.join(""));
}

/**
 * The capture pair that provably brackets the turn. The baseline is the
 * `start` pinned for it: taken after the previous turn, while the dispatch
 * hook held this one back. The end is the first `end` after the turn that
 * finished no later than the next turn's baseline, which the next dispatch
 * waited for. With no such proof, there is no pair.
 */
function bracket(captures: Capture[], window: TurnWindow) {
  const start = captures.findLast(
    (capture) =>
      capture.kind === "start" &&
      capture.at >= window.prevCompletedAt &&
      capture.at < window.startedAt,
  );
  const { nextStartedAt } = window;
  const next =
    nextStartedAt === null
      ? null
      : captures.findLast(
          (capture) =>
            capture.kind === "start" &&
            capture.at >= window.completedAt &&
            capture.at < nextStartedAt,
        );
  if (!start || next === undefined) return null;
  const end = captures.find(
    (capture) =>
      capture.kind === "end" &&
      capture.at >= window.completedAt &&
      (next === null || capture.finishedAt <= next.finishedAt),
  );
  return end ? { start, end } : null;
}

/** Whether `threadId` was mid-turn at `at`: its latest lifecycle capture opened a turn. */
function running(captures: Capture[], threadId: string, at: number): boolean {
  const last = captures.findLast(
    (capture) => capture.threadId === threadId && capture.kind !== "start" && capture.at <= at,
  );
  return (last?.kind === "open" || last?.kind === "run") && at - last.at < MAX_TURN_MS;
}

async function changedPaths(target: Checkout, from: Capture, to: Capture, signal: AbortSignal) {
  if (from.tree === to.tree) return [];
  const paths: string[] = [];
  const args = ["diff-tree", "-r", "-z", "--no-renames", "--name-only", from.tree, to.tree];
  await gitFields(target.top, args, signal, (path) => paths.push(path.toString("utf8")));
  return paths;
}

/**
 * Files another agent in the same checkout may have written. The window is
 * cut at every snapshot any thread took inside it. A segment where no other
 * thread was mid-turn belongs to this thread outright. Files that changed only
 * in shared segments are contested; the caller subtracts the ones this turn
 * recorded editing.
 */
async function contestedPaths(
  target: Checkout,
  all: Capture[],
  threadId: string,
  start: Capture,
  end: Capture,
  signal: AbortSignal,
): Promise<string[]> {
  const inside = all.filter((c) => isSnapshot(c) && c.at > start.at && c.at < end.at);
  const cuts = [start, ...inside, end];
  const others = [...new Set(all.map((c) => c.threadId))].filter((id) => id !== threadId);
  const mine = new Set<string>();
  const shared = new Set<string>();
  for (let i = 0; i + 1 < cuts.length; i++) {
    const from = cuts[i]!;
    const to = cuts[i + 1]!;
    // A `run` marker is no cut point, so a thread may start running mid-segment.
    const starts = (c: Capture) =>
      (c.kind === "open" || c.kind === "run") && c.at > from.at && c.at < to.at;
    const contested = others.some(
      (other) => running(all, other, from.at) || all.some((c) => c.threadId === other && starts(c)),
    );
    for (const path of await changedPaths(target, from, to, signal)) {
      (contested ? shared : mine).add(path);
    }
  }
  return [...shared].filter((path) => !mine.has(path));
}

/**
 * `start`'s tree with every change between `start` and `end` applied except
 * those to repository-relative `foreign` paths: the turn's own files alone.
 * Where an own file and a foreign one collide as file and directory, the own
 * file wins, so this turn's edits are never lost. Changes stream through
 * stdin, so no file count can overflow a buffer or the command line.
 */
async function ownTree(
  target: Checkout,
  start: string,
  end: string,
  foreign: readonly string[],
  signal: AbortSignal,
): Promise<string> {
  const theirs = new Set(foreign);
  const info: Buffer[] = [];
  // Records alternate `:<old mode> <new mode> <old id> <new id> <status>` and a path.
  let record: string | null = null;
  const args = ["diff-tree", "-r", "-z", "--no-renames", start, end];
  await gitFields(target.top, args, signal, (field) => {
    if (record === null) {
      record = field.toString("latin1");
      return;
    }
    // A deleted file's new mode and id are zeros, which removes the entry.
    // The path goes back byte for byte; only the lookup decodes it.
    const [, mode, , id] = record.slice(1).split(" ");
    if (!theirs.has(field.toString("utf8"))) {
      info.push(Buffer.from(`${mode} ${id}\t`), field, Buffer.from([0]));
    }
    record = null;
  });
  const scratch = await mkdtemp(join(tmpdir(), "bb-last-turn-"));
  try {
    const env = { GIT_INDEX_FILE: join(scratch, "index") };
    await git(target.top, ["read-tree", start], signal, env);
    await git(target.top, ["update-index", "-z", "--index-info"], signal, env, Buffer.concat(info));
    return (await git(target.top, ["write-tree"], signal, env)).trim();
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Bytes `text` takes in the JSON answer. Escapes can grow control characters
 * sixfold, and bb rejects host answers past a fixed size.
 */
function wireBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text));
}

/**
 * Others' changes are context, held to the preview limit file by file. A file
 * whose hunks do not fit keeps its header, with its mode, rename, and binary
 * lines, so it is listed without being misdescribed. Headers draw on a budget
 * of their own, which keeps the answer bounded however many files changed.
 */
export function preview(patch: string): string {
  let room = MAX_PATCH_BYTES;
  let listing = MAX_PATCH_BYTES;
  const kept: string[] = [];
  for (const chunk of patch.split(/^(?=diff --git )/m)) {
    if (!chunk.startsWith("diff --git ")) continue;
    const size = wireBytes(chunk);
    if (size <= room) {
      room -= size;
      kept.push(chunk);
      continue;
    }
    const body = chunk.search(/^@@ /m);
    const header = body === -1 ? chunk : chunk.slice(0, body);
    const headerSize = wireBytes(header);
    if (headerSize > listing) continue;
    listing -= headerSize;
    kept.push(header);
  }
  return kept.join("");
}

/** A header-only patch for a file, quoted the way Git quotes names. */
function stub(name: string): string {
  const quoted = [...name].some(needsQuote);
  const side = (prefix: string) => (quoted ? `"${prefix}/${quote(name)}"` : `${prefix}/${name}`);
  // Git ends a ---/+++ name holding a space with a tab, so parsers know where it ends.
  const end = !quoted && name.includes(" ") ? "\t" : "";
  return `diff --git ${side("a")} ${side("b")}\n--- ${side("a")}${end}\n+++ ${side("b")}${end}\n`;
}

const C_ESCAPES: Record<string, string> = {
  "\x07": "\\a",
  "\b": "\\b",
  "\t": "\\t",
  "\n": "\\n",
  "\v": "\\v",
  "\f": "\\f",
  "\r": "\\r",
  '"': '\\"',
  "\\": "\\\\",
};

/** Characters Git quotes even with `core.quotePath=false`. */
function needsQuote(char: string): boolean {
  const code = char.charCodeAt(0);
  return char === '"' || char === "\\" || code < 0x20 || code === 0x7f;
}

/** Git's C-style quoting, the inverse of the app's `unquoteGitPath`. */
function quote(name: string): string {
  return [...name]
    .map((char) =>
      needsQuote(char)
        ? (C_ESCAPES[char] ?? `\\${char.charCodeAt(0).toString(8).padStart(3, "0")}`)
        : char,
    )
    .join("");
}

/** Resolve symlinks (macOS `/tmp` is `/private/tmp`), including for deleted files. */
async function resolvePath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return await realpath(dirname(path))
      .then((parent) => join(parent, basename(path)))
      .catch(() => path);
  }
}

/** Repository-relative forms of the paths the provider recorded, dropping ones outside it. */
async function repoPaths(
  target: Checkout,
  environmentPath: string,
  paths: readonly string[],
): Promise<Set<string>> {
  const resolved = await Promise.all(
    paths.map((path) => resolvePath(isAbsolute(path) ? path : resolve(environmentPath, path))),
  );
  return new Set(
    resolved
      .map((path) => relative(target.top, path))
      .filter((path) => path && !path.startsWith("..") && !isAbsolute(path)),
  );
}

function inEnvironment(target: Checkout, paths: string[]): string[] {
  return paths
    .filter((path) => path.startsWith(target.prefix))
    .map((path) => path.slice(target.prefix.length));
}

/** Repository-relative submodule roots in the end capture. */
async function submodules(target: Checkout, end: string, signal: AbortSignal) {
  const roots: string[] = [];
  await gitFields(target.top, ["ls-tree", "-r", "-z", end], signal, (entry) => {
    const text = entry.toString("utf8");
    if (text.startsWith("160000 ")) roots.push(text.slice(text.indexOf("\t") + 1));
  });
  return roots;
}

/** Recorded paths Git ignores, which snapshots never hold. */
async function ignored(
  target: Checkout,
  paths: ReadonlySet<string>,
  roots: readonly string[],
  signal: AbortSignal,
) {
  // A path inside a submodule fails the whole check-ignore batch.
  const inside = (path: string) => roots.some((root) => path.startsWith(`${root}/`));
  const candidates = [...paths].filter((path) => !inside(path));
  if (candidates.length === 0) return [];
  // check-ignore exits 1 when no path is ignored.
  const out = await git(
    target.top,
    ["check-ignore", "-z", "--stdin"],
    signal,
    {},
    candidates.join("\0"),
  ).catch(() => "");
  return out.split("\0").filter(Boolean);
}

/** A remembered pair, when both commits still exist. */
async function knownPair(target: Checkout, known: Attribution | undefined, signal: AbortSignal) {
  if (!known) return null;
  const out = await git(
    target.top,
    ["cat-file", "--batch-check=%(objecttype)"],
    signal,
    {},
    `${known.start}\n${known.end}\n`,
  ).catch(() => "");
  return out === "commit\ncommit\n" ? { start: known.start, end: known.end } : null;
}

/**
 * The diff between the captures bracketing a turn, or null when this thread
 * has no valid pair of captures around it. Paths are relative to
 * `environmentPath`. `recordedPaths` are the files the provider recorded
 * editing, as it reported them. `known` reuses an earlier attribution for the
 * same capture pair, which losing other threads' captures must not change.
 */
export async function turnPatch(
  environmentPath: string,
  threadId: string,
  window: TurnWindow,
  recordedPaths: readonly string[],
  known: Attribution | undefined,
  signal: AbortSignal,
): Promise<SnapshotPatch | null> {
  const target = await checkout(environmentPath, signal);
  if (!target) return null;
  const all = (await listRefs(target, target.refPrefix, signal)).captures;
  // A pair proven once stays proven, even after a later Send-now turn
  // leaves nothing to prove its end by.
  const remembered = await knownPair(target, known, signal);
  const proven = remembered
    ? null
    : bracket(
        all.filter((capture) => capture.threadId === threadId),
        window,
      );
  if (!remembered && !proven) return null;
  const start = remembered?.start ?? proven!.start.commit;
  const end = remembered?.end ?? proven!.end.commit;
  const scope = target.prefix ? [`--relative=${target.prefix}`] : [];
  const flags = ["--no-ext-diff", "--no-textconv", "--no-color", "-M", ...scope];
  // Ownership only grows: a later read whose summary failed keeps earlier evidence.
  const own = new Set([
    ...(await repoPaths(target, environmentPath, recordedPaths)),
    ...(remembered ? known!.owned : []),
  ]);
  const contested = proven
    ? await contestedPaths(target, all, threadId, proven.start, proven.end, signal)
    : known!.contested;
  const foreign = contested.filter((path) => !own.has(path));
  const roots = await submodules(target, end, signal);
  const diff = (from: string, to: string, limit: number) =>
    gitCapped(
      target.top,
      [...DIFF_CONFIG, "diff", ...flags, "--src-prefix=a/", "--dst-prefix=b/", from, to],
      limit,
      signal,
    );
  /** This turn's patch, or null when it does not fit the preview limit. */
  const ownPatch = async (from: string, to: string) => {
    const text = await diff(from, to, MAX_PATCH_BYTES);
    return text !== null && wireBytes(text) <= MAX_PATCH_BYTES ? text : null;
  };
  const base = {
    root: join(target.top, target.prefix).replace(/\/$/, ""),
    path: environmentPath.replace(/\/+$/, ""),
    uncovered: inEnvironment(target, [...roots, ...(await ignored(target, own, roots, signal))]),
    attribution: {
      start,
      end,
      contested,
      owned: contested.filter((path) => own.has(path)),
    },
  };
  if (foreign.length === 0) {
    const patch = await ownPatch(start, end);
    return { ...base, patch, otherPatch: null, limited: patch === null };
  }
  // Diff each side from a tree holding only this turn's files, so others'
  // changes, however large, never crowd out the turn's own preview.
  const mine = await ownTree(target, start, end, foreign, signal);
  const patch = await ownPatch(start, mine);
  const others = await diff(mine, end, MAX_OUTPUT_BYTES);
  // Past even the read limit, others' files are listed by name, up to the preview limit.
  const listed = async () => {
    const stubs: string[] = [];
    let room = MAX_PATCH_BYTES;
    const args = [...DIFF_CONFIG, "diff", ...flags, "-z", "--name-only", mine, end];
    await gitFields(target.top, args, signal, (name) => {
      const next = stub(name.toString("utf8"));
      const size = wireBytes(next);
      if (size > room) return;
      room -= size;
      stubs.push(next);
    });
    return stubs.join("");
  };
  const otherPatch = others === null ? await listed() : preview(others);
  return { ...base, patch, otherPatch: otherPatch || null, limited: patch === null };
}
