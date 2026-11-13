/**
 * Plain-git reads of a checkout for other plugins (core/checkout-reads.ts):
 * its status against a base branch, and the files and patches of its
 * uncommitted work, its branch, or one commit. Untracked files count as
 * added, as git status shows them.
 */
import { access, open } from "node:fs/promises";
import { join } from "node:path";
import {
  MAX_CHECKOUT_COMMITS,
  MAX_CHECKOUT_FILES,
  type CheckoutCommit,
  type CheckoutFile,
  type CheckoutFiles,
  type CheckoutHead,
  type CheckoutPatchFile,
  type CheckoutStatus,
  type CheckoutTarget,
} from "../core/checkout-reads.ts";
import type { FilePatch } from "../core/change.ts";
import { readCheckout, type Checkout } from "./checkout.ts";
import { CommandFailedError, optionalGit, runGit, runGitCommand } from "./cli.ts";
import { DIFF_OPTIONS, MAX_PATCH_CHARS } from "./git-workspace.ts";
import { patchesFromGit } from "./parse.ts";
import { compareRemote, parseNameStatus, parseNumstat } from "./range.ts";

/** Untracked files larger than this are listed without counting their lines. */
const MAX_COUNTED_BYTES = 4 * 1024 * 1024;
/** Bytes git checks for a NUL to call a file binary. */
const BINARY_PROBE = 8000;
/** Most files, and changed lines, whose patches a files read includes. */
const INLINE_FILES = 50;
const INLINE_LINES = 3000;

const NAME_ARGS = ["-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff", "-M", "-z"];

async function emptyTree(cwd: string, signal: AbortSignal): Promise<string> {
  return (
    await runGit(cwd, ["hash-object", "-t", "tree", "--stdin"], signal, { input: "" })
  ).trim();
}

const commitOf = (cwd: string, ref: string, signal: AbortSignal) =>
  optionalGit(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], signal);

/** A base branch's commit: the remote's copy where there is one, as it is the one a pull request targets, else the local branch. */
export async function branchCommit(
  cwd: string,
  name: string,
  signal: AbortSignal,
): Promise<string | null> {
  const remote = await compareRemote(cwd, signal);
  return (
    (remote ? await commitOf(cwd, `refs/remotes/${remote}/${name}`, signal) : null) ??
    (await commitOf(cwd, `refs/heads/${name}`, signal))
  );
}

/** The remote's default branch, else `main` or `master` where one exists. */
export async function defaultBranch(cwd: string, signal: AbortSignal): Promise<string | null> {
  const remote = await compareRemote(cwd, signal);
  if (remote) {
    const head = await optionalGit(
      cwd,
      ["symbolic-ref", "-q", "--short", `refs/remotes/${remote}/HEAD`],
      signal,
    );
    if (head?.startsWith(`${remote}/`)) return head.slice(remote.length + 1);
  }
  for (const name of ["main", "master"]) {
    if (await branchCommit(cwd, name, signal)) return name;
  }
  return null;
}

function headOf(checkout: Checkout): CheckoutHead {
  if (checkout.head === null) return { kind: "unborn", name: checkout.branch };
  if (checkout.branch === null) return { kind: "detached", sha: checkout.head };
  return { kind: "branch", name: checkout.branch, sha: checkout.head };
}

/** What `git diff` compares for a target: one commit against the working tree, or two commits. */
type Ends = { revs: string[]; untracked: boolean };

async function endsOf(
  checkout: Checkout,
  target: CheckoutTarget,
  signal: AbortSignal,
): Promise<Ends> {
  const cwd = checkout.path;
  if (target.kind === "commit") {
    const sha = await commitOf(cwd, target.sha, signal);
    if (!sha) throw new CommandFailedError(`This checkout has no commit ${target.sha}.`);
    // A merge's own diff is against its first parent; a root commit's against nothing.
    const parent = (await commitOf(cwd, `${sha}^`, signal)) ?? (await emptyTree(cwd, signal));
    return { revs: [parent, sha], untracked: false };
  }
  if (checkout.head === null) return { revs: [await emptyTree(cwd, signal)], untracked: true };
  if (target.kind === "uncommitted") return { revs: [checkout.head], untracked: true };
  const base = await branchCommit(cwd, target.base, signal);
  if (!base) throw new CommandFailedError(`This checkout has no branch ${target.base}.`);
  const from = await optionalGit(cwd, ["merge-base", checkout.head, base], signal);
  if (!from)
    throw new CommandFailedError(`This branch has no commit in common with ${target.base}.`);
  return { revs: [from], untracked: true };
}

/** Untracked files, as git status lists them (`.gitignore` respected). */
async function untrackedPaths(cwd: string, signal: AbortSignal): Promise<string[]> {
  const output = await runGit(
    cwd,
    ["-c", "core.quotePath=false", "ls-files", "--others", "--exclude-standard", "-z"],
    signal,
  );
  return output.split("\0").filter(Boolean);
}

/** An untracked file's lines, read from disk; binary when its start holds a NUL, as git judges. */
async function untrackedFile(cwd: string, path: string): Promise<CheckoutFile> {
  const file: CheckoutFile = {
    path,
    previousPath: null,
    kind: "added",
    additions: 0,
    deletions: 0,
    binary: false,
    untracked: true,
  };
  const handle = await open(join(cwd, path), "r").catch(() => null);
  if (!handle) return file;
  try {
    const info = await handle.stat();
    const size = info.size;
    if (!info.isFile() || size > MAX_COUNTED_BYTES) return file;
    const bytes = Buffer.alloc(size);
    await handle.read(bytes, 0, size, 0);
    if (bytes.subarray(0, BINARY_PROBE).includes(0)) return { ...file, binary: true };
    let lines = 0;
    for (const byte of bytes) if (byte === 10) lines++;
    // A last line without a newline still counts.
    if (size > 0 && bytes[size - 1] !== 10) lines++;
    return { ...file, additions: lines };
  } finally {
    await handle.close();
  }
}

/** Tracked changes between the ends, then untracked files, each listed once. */
async function changedFiles(cwd: string, ends: Ends, signal: AbortSignal) {
  const [names, numstat, untracked] = await Promise.all([
    runGit(cwd, [...NAME_ARGS, "--name-status", ...ends.revs, "--"], signal),
    runGit(cwd, [...NAME_ARGS, "--numstat", ...ends.revs, "--"], signal),
    ends.untracked ? untrackedPaths(cwd, signal) : [],
  ]);
  const sizes = parseNumstat(numstat);
  const tracked: CheckoutFile[] = parseNameStatus(names).map((file) =>
    Object.assign(file, sizes.get(file.path) ?? { additions: 0, deletions: 0, binary: false }, {
      untracked: false,
    }),
  );
  const listed = new Set(tracked.map((file) => file.path));
  const fresh = untracked.filter((path) => !listed.has(path));
  const room = Math.max(0, MAX_CHECKOUT_FILES - tracked.length);
  const counted = await Promise.all(fresh.slice(0, room).map((path) => untrackedFile(cwd, path)));
  const files = [...tracked, ...counted].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  return { files, total: tracked.length + fresh.length };
}

async function patchesOf(
  cwd: string,
  ends: Ends,
  files: readonly (CheckoutPatchFile & { untracked: boolean })[],
  signal: AbortSignal,
): Promise<FilePatch[]> {
  const tracked = files.filter((file) => !file.untracked);
  // A rename's patch needs its old path in the pathspec too.
  const paths = tracked.flatMap((file) =>
    file.previousPath ? [file.previousPath, file.path] : [file.path],
  );
  let output = paths.length
    ? await runGit(cwd, [...DIFF_OPTIONS, ...ends.revs, "--", ...paths], signal)
    : "";
  for (const file of files) {
    if (!file.untracked || output.length > MAX_PATCH_CHARS) continue;
    const diff = await runGitCommand(
      cwd,
      [...DIFF_OPTIONS, "--no-index", "--", "/dev/null", file.path],
      signal,
    );
    if (diff.code !== 0 && diff.code !== 1)
      throw new CommandFailedError(diff.stderr.trim() || "The untracked file could not be read.");
    output += diff.stdout;
  }
  const wanted = new Set(files.map((file) => file.path));
  return patchesFromGit(output, MAX_PATCH_CHARS).files.filter((patch) => wanted.has(patch.path));
}

/** The first files whose patches fit one read. */
function inline(files: readonly CheckoutFile[]): CheckoutFile[] {
  const picked: CheckoutFile[] = [];
  let lines = 0;
  for (const file of files) {
    if (picked.length === INLINE_FILES) break;
    if (file.binary) continue;
    const size = file.additions + file.deletions;
    if (lines + size > INLINE_LINES) continue;
    lines += size;
    picked.push(file);
  }
  return picked;
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

async function checkoutAt(path: string, signal: AbortSignal): Promise<Checkout> {
  const checkout = await readCheckout(path, signal);
  if (!checkout) throw new CommandFailedError("Not a Git checkout.");
  return checkout;
}

export async function readCheckoutFiles(
  path: string,
  target: CheckoutTarget,
  signal: AbortSignal,
): Promise<CheckoutFiles> {
  const checkout = await checkoutAt(path, signal);
  const ends = await endsOf(checkout, target, signal);
  const { files, total } = await changedFiles(checkout.path, ends, signal);
  const patches = await patchesOf(checkout.path, ends, inline(files), signal);
  return { files, truncated: total > files.length, patches };
}

export async function readCheckoutPatches(
  path: string,
  target: CheckoutTarget,
  files: readonly CheckoutPatchFile[],
  signal: AbortSignal,
): Promise<FilePatch[]> {
  const checkout = await checkoutAt(path, signal);
  const ends = await endsOf(checkout, target, signal);
  const untracked = new Set(ends.untracked ? await untrackedPaths(checkout.path, signal) : []);
  return patchesOf(
    checkout.path,
    ends,
    files.map((file) => ({ ...file, untracked: untracked.has(file.path) })),
    signal,
  );
}

/** `git log -z` with author name and time: four NUL-terminated fields a commit. */
const LOG_FORMAT = "--format=%H%x00%an%x00%at%x00%s";

function parseLog(output: string): CheckoutCommit[] {
  const fields = output.split("\0");
  const commits: CheckoutCommit[] = [];
  for (let index = 0; index + 3 < fields.length; index += 4) {
    const sha = (fields[index] ?? "").replace(/^\n/, "");
    if (sha === "") continue;
    commits.push({
      sha,
      author: fields[index + 1] ?? "",
      authoredAt: Number(fields[index + 2]) * 1000 || 0,
      subject: fields[index + 3] ?? "",
    });
  }
  return commits;
}

async function mergeBaseOf(cwd: string, head: string, base: string, signal: AbortSignal) {
  const baseHead = await branchCommit(cwd, base, signal);
  if (!baseHead) return null;
  const from = await optionalGit(cwd, ["merge-base", head, baseHead], signal);
  if (!from) return null;
  const [counts, log] = await Promise.all([
    runGit(cwd, ["rev-list", "--left-right", "--count", `${head}...${baseHead}`, "--"], signal),
    runGit(
      cwd,
      [
        "log",
        "-z",
        "--no-show-signature",
        LOG_FORMAT,
        `--max-count=${MAX_CHECKOUT_COMMITS}`,
        `${from}..${head}`,
        "--",
      ],
      signal,
    ),
  ]);
  const [ahead = 0, behind = 0] = counts.trim().split(/\s+/).map(Number);
  return { ahead, behind, commits: parseLog(log) };
}

export async function readCheckoutStatus(
  path: string,
  base: string | null,
  signal: AbortSignal,
): Promise<CheckoutStatus> {
  const checkout = await readCheckout(path, signal);
  if (!checkout) return (await exists(path)) ? { state: "not-git" } : { state: "missing" };
  const cwd = checkout.path;
  const ends: Ends = { revs: [checkout.head ?? (await emptyTree(cwd, signal))], untracked: true };
  const [fallback, changed] = await Promise.all([
    defaultBranch(cwd, signal),
    changedFiles(cwd, ends, signal),
  ]);
  const compared = base ?? fallback;
  const mergeBase =
    checkout.head && compared ? await mergeBaseOf(cwd, checkout.head, compared, signal) : null;
  return {
    state: "read",
    head: headOf(checkout),
    defaultBranch: fallback,
    base: compared,
    uncommitted: {
      files: changed.total,
      additions: changed.files.reduce((sum, file) => sum + file.additions, 0),
      deletions: changed.files.reduce((sum, file) => sum + file.deletions, 0),
    },
    mergeBase,
  };
}
