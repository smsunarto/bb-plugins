import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { CaptureKind, SnapshotPatch } from "../shared/host-contract.ts";

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
 * Ref layout: `refs/bb-last-turn/<checkout>/<thread>/<at>-<kind>`. `checkout`
 * hashes the worktree root, so linked worktrees sharing one ref store never
 * see each other's captures. `at` is the server's clock, the same clock that
 * stamps turn events.
 */
const NAMESPACE = "refs/bb-last-turn";
/** Captures retained per thread. Two per turn, so the last several turns. */
const KEEP = 16;
/** `thread.active` lands just after `turn/started` when a turn skipped the dispatch hook. */
const START_GRACE_MS = 2_000;
const MAX_PATCH_CHARS = 1_000_000;
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

interface Capture {
  ref: string;
  commit: string;
  threadId: string;
  at: number;
  kind: CaptureKind;
}

function git(
  cwd: string,
  args: readonly string[],
  signal: AbortSignal,
  env: Record<string, string> = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        encoding: "utf8",
        maxBuffer: MAX_OUTPUT_BYTES,
        signal,
        windowsHide: true,
        // Never take optional locks on the real index GitButler also writes.
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", ...env },
      },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || error.message));
        else resolve(stdout);
      },
    );
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

async function listCaptures(
  target: Checkout,
  prefix: string,
  signal: AbortSignal,
): Promise<Capture[]> {
  const out = await git(
    target.top,
    ["for-each-ref", "--format=%(refname) %(objectname)", prefix],
    signal,
  );
  const captures: Capture[] = [];
  for (const line of out.split("\n")) {
    const [ref, commit] = line.split(" ");
    const match = ref?.slice(target.refPrefix.length).match(/^([^/]+)\/(\d+)-(start|end)$/);
    if (!ref || !commit || !match) continue;
    captures.push({
      ref,
      commit,
      threadId: match[1]!,
      at: Number(match[2]),
      kind: match[3] as CaptureKind,
    });
  }
  return captures.sort((a, b) => a.at - b.at);
}

/** Record the checkout's current files, including untracked, non-ignored ones. */
export async function capture(
  environmentPath: string,
  threadId: string,
  at: number,
  kind: CaptureKind,
  signal: AbortSignal,
): Promise<boolean> {
  const target = await checkout(environmentPath, signal);
  if (!target) return false;
  const scratch = await mkdtemp(join(tmpdir(), "bb-last-turn-"));
  try {
    const index = join(scratch, "index");
    // Seeding from the real index reuses its stat cache, so only files that
    // changed are rehashed. The real index is only ever read.
    const real = (
      await git(target.top, ["rev-parse", "--path-format=absolute", "--git-path", "index"], signal)
    ).trim();
    await copyFile(real, index).catch(() => undefined);
    const env = { GIT_INDEX_FILE: index };
    // fsmonitor state belongs to the real index; a full stat walk is exact.
    await git(target.top, ["-c", "core.fsmonitor=false", "add", "--all", "--", "."], signal, env);
    const tree = (await git(target.top, ["write-tree"], signal, env)).trim();
    const date = `@${Math.floor(at / 1000)} +0000`;
    const commit = (
      await git(target.top, ["commit-tree", tree, "-m", `bb last-turn ${kind}`], signal, {
        ...IDENTITY,
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
      })
    ).trim();
    const prefix = threadPrefix(target, threadId);
    await git(
      target.top,
      ["update-ref", `${prefix}${String(at).padStart(15, "0")}-${kind}`, commit],
      signal,
    );
    const stale = (await listCaptures(target, prefix, signal)).slice(0, -KEEP);
    // Pruning races other threads' pruning on packed-refs; the next capture retries.
    if (stale.length > 0) await deleteRefs(target, stale, signal).catch(() => undefined);
    return true;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function deleteRefs(target: Checkout, captures: Capture[], signal: AbortSignal) {
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      "git",
      ["update-ref", "--stdin"],
      { cwd: target.top, signal, windowsHide: true },
      (error) => (error ? reject(error) : resolve()),
    );
    child.stdin?.end(captures.map((capture) => `delete ${capture.ref}\n`).join(""));
  });
}

/** Drop every capture this thread holds in the checkout. */
export async function forget(
  environmentPath: string,
  threadId: string,
  signal: AbortSignal,
): Promise<void> {
  const target = await checkout(environmentPath, signal);
  if (!target) return;
  const captures = await listCaptures(target, threadPrefix(target, threadId), signal);
  if (captures.length > 0) await deleteRefs(target, captures, signal);
}

function bracket(captures: Capture[], startedAt: number, completedAt: number) {
  // The newest capture up to just after the start. A late `thread.active`
  // capture must win over the previous turn's end, or edits made between the
  // turns would land in this one.
  const start = captures.findLast(
    (capture) => capture.at <= startedAt + START_GRACE_MS && capture.at < completedAt,
  );
  const end = captures.find((capture) => capture.at >= completedAt);
  return start && end && start.at < end.at ? { start, end } : null;
}

/** Whether `threadId` was mid-turn at `at`: its latest capture by then opened a turn. */
function running(captures: Capture[], threadId: string, at: number): boolean {
  return (
    captures.findLast((capture) => capture.threadId === threadId && capture.at <= at)?.kind ===
    "start"
  );
}

async function changedPaths(
  target: Checkout,
  from: string,
  to: string,
  signal: AbortSignal,
): Promise<string[]> {
  const out = await git(
    target.top,
    ["diff-tree", "-r", "-z", "--no-renames", "--name-only", from, to],
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
): Promise<Set<string>> {
  const cuts = [start, ...all.filter((c) => c.at > start.at && c.at < end.at), end];
  const others = [...new Set(all.map((c) => c.threadId))].filter((id) => id !== threadId);
  const mine = new Set<string>();
  const shared = new Set<string>();
  for (let i = 0; i + 1 < cuts.length; i++) {
    const from = cuts[i]!;
    const to = cuts[i + 1]!;
    if (from.commit === to.commit) continue;
    const contested = others.some((other) => running(all, other, from.at));
    for (const path of await changedPaths(target, from.commit, to.commit, signal)) {
      (contested ? shared : mine).add(path);
    }
  }
  return new Set([...shared].filter((path) => !mine.has(path) && !ownPaths.has(path)));
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

/**
 * The diff between the captures bracketing a turn, or null when this thread
 * has no pair of captures around it. Paths are relative to `environmentPath`.
 * `recordedPaths` are the files the provider recorded editing, as it reported them.
 */
export async function turnPatch(
  environmentPath: string,
  threadId: string,
  startedAt: number,
  completedAt: number,
  recordedPaths: readonly string[],
  signal: AbortSignal,
): Promise<SnapshotPatch | null> {
  const target = await checkout(environmentPath, signal);
  if (!target) return null;
  const all = await listCaptures(target, target.refPrefix, signal);
  const window = bracket(
    all.filter((capture) => capture.threadId === threadId),
    startedAt,
    completedAt,
  );
  if (!window) return null;
  const { start, end } = window;
  const range = [start.commit, end.commit];
  const scope = target.prefix ? [`--relative=${target.prefix}`] : [];
  const flags = ["--no-ext-diff", "--no-textconv", "--no-color", "-M", ...scope];
  const patch = await git(
    target.top,
    [...DIFF_CONFIG, "diff", ...flags, "--src-prefix=a/", "--dst-prefix=b/", ...range],
    signal,
  );
  const foreign = await foreignPaths(
    target,
    all,
    threadId,
    start,
    end,
    await repoPaths(target, environmentPath, recordedPaths),
    signal,
  );
  const root = join(target.top, target.prefix).replace(/\/$/, "");
  const whole = patch.length > MAX_PATCH_CHARS ? null : patch;
  const unsplit = { root, patch: whole, otherPatch: null, limited: whole === null };
  if (foreign.size === 0) return unsplit;

  const names = (
    await git(target.top, [...DIFF_CONFIG, "diff", ...flags, "-z", "--name-only", ...range], signal)
  )
    .split("\0")
    .filter(Boolean);
  const chunks = whole === null ? null : fileChunks(whole, names);
  // Without a reliable file split, keep everything rather than hide changes.
  if (chunks === null) return unsplit;
  const isForeign = (path: string) => foreign.has(target.prefix + path);
  const pick = (foreignFiles: boolean) =>
    chunks
      .filter((chunk) => isForeign(chunk.path) === foreignFiles)
      .map((chunk) => chunk.text)
      .join("");
  return { root, patch: pick(false), otherPatch: pick(true) || null, limited: false };
}
