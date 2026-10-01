import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  Attribution,
  CaptureKind,
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
 * store never see each other's captures. `at` is the server's clock when the
 * capture was requested, the clock that stamps turn events. `finishedAt` adds
 * the capture's own duration: the files were read somewhere in between.
 */
const NAMESPACE = "refs/bb-last-turn";
/** Captures retained per thread: start, open, and end for the last several turns. */
const KEEP = 24;
/**
 * A capture finishing this soon after `turn/started` still precedes the
 * turn's first write, which needs at least one model round trip.
 */
const START_GRACE_MS = 1_000;
/** An `open` with no `end` this old came from a lost capture, not a running turn. */
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

interface Capture {
  ref: string;
  commit: string;
  tree: string;
  threadId: string;
  at: number;
  finishedAt: number;
  kind: CaptureKind;
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
      .match(/^([^/]+)\/(\d+)-(\d+)-(start|open|end)$/);
    if (!match) continue;
    captures.push({
      ref,
      commit,
      tree,
      threadId: match[1]!,
      at: Number(match[2]),
      finishedAt: Number(match[3]),
      kind: match[4] as CaptureKind,
    });
  }
  return { refs, captures: captures.sort((a, b) => a.at - b.at) };
}

/**
 * Seed the private index from the real one so unchanged files keep their stat
 * cache, then drop the flags that tell `git add` to look away. A file marked
 * assume-unchanged or skip-worktree can still change on disk.
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
  for (const [flag, paths] of [
    ["--no-assume-unchanged", assumed],
    ["--no-skip-worktree", skipped],
  ] as const) {
    if (paths.length === 0) continue;
    await git(target.top, ["update-index", "-z", flag, "--stdin"], signal, env, paths.join("\0"));
  }
}

/** Record the checkout's current files, including untracked, non-ignored ones. */
export async function capture(
  environmentPath: string,
  threadId: string,
  at: number,
  kind: CaptureKind,
  signal: AbortSignal,
): Promise<boolean> {
  const began = performance.now();
  const target = await checkout(environmentPath, signal);
  if (!target) return false;
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
    const date = `@${Math.floor(at / 1000)} +0000`;
    const commit = (
      await git(target.top, ["commit-tree", tree, "-m", `bb last-turn ${kind}`], signal, {
        ...IDENTITY,
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
      })
    ).trim();
    const finishedAt = at + Math.ceil(performance.now() - began);
    const prefix = threadPrefix(target, threadId);
    const name = `${String(at).padStart(15, "0")}-${String(finishedAt).padStart(15, "0")}-${kind}`;
    await git(target.top, ["update-ref", `${prefix}${name}`, commit], signal);
    const stale = (await listRefs(target, prefix, signal)).captures.slice(0, -KEEP);
    // Pruning races other threads' pruning on packed-refs; the next capture retries.
    await deleteRefs(
      target,
      stale.map((capture) => capture.ref),
      signal,
    ).catch(() => undefined);
    return true;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function deleteRefs(target: Checkout, refs: string[], signal: AbortSignal) {
  if (refs.length === 0) return;
  const input = refs.map((ref) => `delete ${ref}\n`).join("");
  await git(target.top, ["update-ref", "--stdin"], signal, {}, input);
}

/** Drop every ref this thread holds in the checkout. */
export async function forget(
  environmentPath: string,
  threadId: string,
  signal: AbortSignal,
): Promise<void> {
  const target = await checkout(environmentPath, signal);
  if (!target) return;
  const { refs } = await listRefs(target, threadPrefix(target, threadId), signal);
  await deleteRefs(target, refs, signal);
}

/**
 * The capture pair that provably brackets the turn. The baseline must come
 * after the previous turn and finish before this one could write. The end must
 * come after the turn and finish before the next one could write. Captures
 * that miss either bound are discarded rather than stretched to fit.
 */
function bracket(captures: Capture[], window: TurnWindow) {
  const baselines = captures.filter(
    (capture) =>
      capture.kind !== "end" &&
      capture.at >= window.prevCompletedAt &&
      capture.at < window.completedAt,
  );
  const start =
    baselines.findLast((capture) => capture.finishedAt <= window.startedAt) ??
    baselines.findLast((capture) => capture.finishedAt <= window.startedAt + START_GRACE_MS);
  const deadline = window.nextStartedAt === null ? Infinity : window.nextStartedAt + START_GRACE_MS;
  const end = captures.find(
    (capture) => capture.at >= window.completedAt && capture.finishedAt <= deadline,
  );
  return start && end && start.at < end.at ? { start, end } : null;
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
 * Split the turn's files into this thread's and those another agent in the
 * same checkout may have written. The window is cut at every capture any
 * thread took inside it. A segment where no other thread was mid-turn belongs
 * to this thread outright. In a shared segment, only files this turn recorded
 * editing are claimed; the rest are reported as others'.
 */
async function foreignPaths(
  target: Checkout,
  all: Capture[],
  threadId: string,
  start: Capture,
  end: Capture,
  ownPaths: ReadonlySet<string>,
  signal: AbortSignal,
): Promise<string[]> {
  const cuts = [start, ...all.filter((c) => c.at > start.at && c.at < end.at), end];
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
  return [...shared].filter((path) => !mine.has(path) && !ownPaths.has(path));
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

/** Environment-relative submodule roots in the end capture. */
async function submodules(target: Checkout, end: Capture, signal: AbortSignal) {
  const out = await git(target.top, ["ls-tree", "-r", "-z", end.tree], signal);
  return out
    .split("\0")
    .filter((entry) => entry.startsWith("160000 "))
    .map((entry) => entry.slice(entry.indexOf("\t") + 1))
    .filter((path) => path.startsWith(target.prefix))
    .map((path) => path.slice(target.prefix.length));
}

/**
 * The diff between the captures bracketing a turn, or null when this thread
 * has no valid pair of captures around it. Paths are relative to
 * `environmentPath`. `recordedPaths` are the files the provider recorded
 * editing, as it reported them. `known` reuses an earlier attribution for the
 * same capture pair, which pruning other threads' captures must not change.
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
  const foreign =
    known?.start === start.commit && known.end === end.commit
      ? known.foreign
      : await foreignPaths(
          target,
          all,
          threadId,
          start,
          end,
          await repoPaths(target, environmentPath, recordedPaths),
          signal,
        );
  const base = {
    root: join(target.top, target.prefix).replace(/\/$/, ""),
    uncovered: await submodules(target, end, signal),
    attribution: { start: start.commit, end: end.commit, foreign },
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
