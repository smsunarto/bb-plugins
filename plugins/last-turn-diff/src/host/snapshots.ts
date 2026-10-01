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
  input?: string,
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

interface Checkout {
  top: string;
  /** The environment path relative to `top`, with a trailing slash, or "". */
  prefix: string;
  refPrefix: string;
}

async function checkout(path: string, signal: AbortSignal): Promise<Checkout | null> {
  let out: string;
  try {
    out = await git(path, ["rev-parse", "--show-toplevel", "--show-prefix"], signal);
  } catch {
    return null; // Not a git checkout: nothing to snapshot.
  }
  const [top = "", prefix = ""] = out.split("\n");
  const key = createHash("sha256").update(top).digest("hex").slice(0, 16);
  return { top, prefix, refPrefix: `${NAMESPACE}/${key}/` };
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
      .slice(target.refPrefix.length)
      .match(/^([^/]+)\/(\d+)-(\d+)-(start|open|end|stop|gone)$/);
    if (!match) continue;
    captures.push({
      ref,
      commit,
      tree,
      threadId: match[1]!,
      at: Number(match[2]),
      finishedAt: Number(match[3]),
      kind: match[4] as Kind,
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
  await listRefs(target, target.refPrefix, signal)
    .then(({ captures }) => deleteRefs(target, stale(captures, now), signal))
    .catch(() => undefined);
}

/**
 * Captures no turn can still need: older than any turn's window, beyond each
 * live thread's latest few. A forgotten thread keeps only recent ones.
 */
function stale(captures: Capture[], now: number): string[] {
  const horizon = now - MAX_TURN_MS;
  const threads = new Map<string, Capture[]>();
  for (const capture of captures) {
    threads.set(capture.threadId, [...(threads.get(capture.threadId) ?? []), capture]);
  }
  const refs: string[] = [];
  for (const list of threads.values()) {
    const gone = list.at(-1)?.kind === "gone";
    for (const [i, capture] of list.entries()) {
      if (capture.at < horizon && (gone || i < list.length - KEEP)) refs.push(capture.ref);
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
  const kept = captures.filter((capture) => capture.at >= at - MAX_TURN_MS && isSnapshot(capture));
  const lines = refs
    .filter((ref) => !kept.some((capture) => capture.ref === ref))
    .map((ref) => `delete ${ref}\n`);
  const latest = kept.at(-1);
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
  return last?.kind === "open" && at - last.at < MAX_TURN_MS;
}

async function changedPaths(target: Checkout, from: Capture, to: Capture, signal: AbortSignal) {
  if (from.tree === to.tree) return [];
  const out = await git(
    target.top,
    ["diff-tree", "-r", "-z", "--no-renames", "--name-only", from.tree, to.tree],
    signal,
  );
  return out.split("\0").filter(Boolean);
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
    const contested = others.some((other) => running(all, other, from.at));
    for (const path of await changedPaths(target, from, cuts[i + 1]!, signal)) {
      (contested ? shared : mine).add(path);
    }
  }
  return [...shared].filter((path) => !mine.has(path));
}

/** Split a `git diff` patch into per-file chunks keyed by post-image path. */
function fileChunks(patch: string, names: string[]): { path: string; text: string }[] | null {
  const chunks = patch
    .split(/^(?=diff --git )/m)
    .filter((chunk) => chunk.startsWith("diff --git "));
  if (chunks.length !== names.length) return null;
  return chunks.map((text, i) => ({ path: names[i]!, text }));
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

/** Environment-relative submodule roots in the end capture. */
async function submodules(target: Checkout, end: Capture, signal: AbortSignal) {
  const out = await git(target.top, ["ls-tree", "-r", "-z", end.tree], signal);
  const roots = out
    .split("\0")
    .filter((entry) => entry.startsWith("160000 "))
    .map((entry) => entry.slice(entry.indexOf("\t") + 1));
  return inEnvironment(target, roots);
}

/** Environment-relative recorded paths Git ignores, which snapshots never hold. */
async function ignored(target: Checkout, paths: ReadonlySet<string>, signal: AbortSignal) {
  if (paths.size === 0) return [];
  // check-ignore exits 1 when no path is ignored.
  const out = await git(
    target.top,
    ["check-ignore", "-z", "--stdin"],
    signal,
    {},
    [...paths].join("\0"),
  ).catch(() => "");
  return inEnvironment(target, out.split("\0").filter(Boolean));
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
  const pair = bracket(
    all.filter((capture) => capture.threadId === threadId),
    window,
  );
  if (!pair) return null;
  const { start, end } = pair;
  const range = [start.commit, end.commit];
  const scope = target.prefix ? [`--relative=${target.prefix}`] : [];
  const flags = ["--no-ext-diff", "--no-textconv", "--no-color", "-M", ...scope];
  const patch = await gitCapped(
    target.top,
    [...DIFF_CONFIG, "diff", ...flags, "--src-prefix=a/", "--dst-prefix=b/", ...range],
    MAX_PATCH_BYTES,
    signal,
  );
  const own = await repoPaths(target, environmentPath, recordedPaths);
  const contested =
    known?.start === start.commit && known.end === end.commit
      ? known.contested
      : await contestedPaths(target, all, threadId, start, end, signal);
  const foreign = contested.filter((path) => !own.has(path));
  const base = {
    root: join(target.top, target.prefix).replace(/\/$/, ""),
    uncovered: [
      ...(await submodules(target, end, signal)),
      ...(await ignored(target, own, signal)),
    ],
    attribution: { start: start.commit, end: end.commit, contested },
  };
  const unsplit = { ...base, patch, otherPatch: null, limited: patch === null };
  if (foreign.length === 0 || patch === null) return unsplit;

  const names = (
    await git(target.top, [...DIFF_CONFIG, "diff", ...flags, "-z", "--name-only", ...range], signal)
  )
    .split("\0")
    .filter(Boolean);
  const chunks = fileChunks(patch, names);
  // Without a reliable file split, keep everything rather than hide changes.
  if (chunks === null) return unsplit;
  const isForeign = new Set(foreign.map((path) => path.slice(target.prefix.length)));
  const pick = (foreignFiles: boolean) =>
    chunks
      .filter((chunk) => isForeign.has(chunk.path) === foreignFiles)
      .map((chunk) => chunk.text)
      .join("");
  return { ...base, patch: pick(false), otherPatch: pick(true) || null, limited: false };
}
