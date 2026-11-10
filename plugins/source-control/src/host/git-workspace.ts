/**
 * The plain-git workspace provider's reads: a checkout with one branch
 * checked out, as one stack of one branch, and its patches. Ported from
 * `plugins/gitbutler/src/host/git-workspace.ts`.
 */
import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  MAX_COMMITS,
  MAX_UNCOMMITTED,
  type Branch,
  type Commit,
  type FileChange,
  type PatchSource,
  type Target,
  type WorkspaceValue,
} from "../core/change.ts";
import { githubHome } from "../core/ids.ts";
import type { Checkout } from "./checkout.ts";
import { CommandFailedError, optionalGit, runGit, runGitCommand } from "./cli.ts";
import {
  GIT_LOG_FORMAT,
  isoTime,
  parseGitLog,
  patchesFromGit,
  subjectOf,
  type PatchSet,
} from "./parse.ts";
import { countSides } from "./upstream.ts";

export const MAX_PATCH_CHARS = 1_500_000;

export type GitRemoteBranch = { remote: string; name: string; ref: string; head: string };

/** What the plain-git writes need beyond the workspace value. */
export type GitDetails = {
  checkout: Checkout;
  target: GitRemoteBranch | null;
  tracking: GitRemoteBranch | null;
  pushRemote: string | null;
  configuredTracking: { remote: string; name: string } | null;
  /** The branch's merge-base with the target. */
  base: string | null;
  status: GitFileStatus;
};

async function remoteBranch(
  cwd: string,
  ref: string | null,
  signal: AbortSignal,
): Promise<GitRemoteBranch | null> {
  if (!ref?.startsWith("refs/remotes/")) return null;
  const rest = ref.slice("refs/remotes/".length);
  const slash = rest.indexOf("/");
  if (slash < 1 || slash === rest.length - 1) return null;
  const head = await optionalGit(
    cwd,
    ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    signal,
  );
  return head ? { remote: rest.slice(0, slash), name: rest.slice(slash + 1), ref, head } : null;
}

/** `text` as a literal in git's extended regular expressions. */
function literal(text: string): string {
  return text.replace(/[.^$*+?()[\]{}|\\]/g, "\\$&");
}

/**
 * Every setting the branch's remotes depend on, in one `git config` read:
 * its own push remote, remote, and merge ref, the default push remote,
 * GitButler's push remote, and the configured remotes' names. Git writes a
 * key's section and name in lower case and its subsection as it is.
 */
async function remoteSettings(cwd: string, branch: string, signal: AbortSignal) {
  const own = `branch\\.${literal(branch)}\\.(pushremote|remote|merge)`;
  const result = await runGitCommand(
    cwd,
    [
      "config",
      "-z",
      "--get-regexp",
      `^(${own}|remote\\..+\\.url|remote\\.pushdefault|gitbutler\\.project\\.pushremote)$`,
    ],
    signal,
  );
  if (result.code !== 0 && result.code !== 1)
    throw new CommandFailedError(result.stderr.trim() || "Git could not read this repository.");
  const values = new Map<string, string>();
  const remotes = new Set<string>();
  for (const entry of result.stdout.split("\0")) {
    const newline = entry.indexOf("\n");
    if (newline === -1) continue;
    const key = entry.slice(0, newline);
    if (key.startsWith("remote.") && key.endsWith(".url")) remotes.add(key.slice(7, -4));
    // A key set more than once takes its last value, as `git config --get` does.
    values.set(key, entry.slice(newline + 1));
  }
  const value = (key: string) => values.get(key) || null;
  return {
    configuredPush: value(`branch.${branch}.pushremote`),
    branchRemote: value(`branch.${branch}.remote`),
    branchMerge: value(`branch.${branch}.merge`),
    defaultPush: value("remote.pushdefault"),
    projectPush: value("gitbutler.project.pushremote"),
    remotes: [...remotes],
  };
}

/** The ref git tracks the branch with, from its configured remote and merge ref. */
async function trackingRefOf(cwd: string, branch: string, signal: AbortSignal) {
  const tracked = await runGit(
    cwd,
    ["for-each-ref", "--format=%(refname)%00%(upstream)", `refs/heads/${branch}`],
    signal,
  );
  return (
    tracked
      .split("\n")
      .map((line) => line.split("\0"))
      .find(([name]) => name === `refs/heads/${branch}`)?.[1] || null
  );
}

/**
 * The branch's remote, as git pushes and pulls it: its configured upstream,
 * else the same name on the push remote. The target is the default branch
 * of `origin` (or the only remote), from its `refs/remotes/<remote>/HEAD`.
 */
async function remotes(cwd: string, branch: string, signal: AbortSignal) {
  const [settings, trackingRef] = await Promise.all([
    remoteSettings(cwd, branch, signal),
    trackingRefOf(cwd, branch, signal),
  ]);
  const { configuredPush, branchRemote, branchMerge, defaultPush, projectPush } = settings;
  const available = settings.remotes;
  const defaultRemote = available.includes("origin")
    ? "origin"
    : available.length === 1
      ? available[0]!
      : null;
  const pushRemote =
    configuredPush ||
    defaultPush ||
    projectPush ||
    (branchRemote !== "." ? branchRemote : null) ||
    defaultRemote;
  const defaultTarget = defaultRemote
    ? await optionalGit(cwd, ["symbolic-ref", "-q", `refs/remotes/${defaultRemote}/HEAD`], signal)
    : null;
  const [target, tracking] = await Promise.all([
    remoteBranch(cwd, defaultTarget, signal),
    remoteBranch(
      cwd,
      trackingRef || (pushRemote ? `refs/remotes/${pushRemote}/${branch}` : null),
      signal,
    ),
  ]);
  const configuredTracking =
    branchRemote && branchMerge?.startsWith("refs/heads/")
      ? { remote: branchRemote, name: branchMerge.slice("refs/heads/".length) }
      : null;
  return { target, tracking, pushRemote, configuredTracking };
}

export type GitFileStatus = { changes: FileChange[]; conflicts: string[]; untracked: string[] };

function changeKind(code: string): FileChange["kind"] {
  if (code === "??" || code.includes("A")) return "added";
  if (code.includes("R")) return "renamed";
  if (code.includes("C")) return "copied";
  if (code.includes("D")) return "deleted";
  return "modified";
}

const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

/** Porcelain v1 is stable, and -z writes paths literally (rename destination first). */
export function parseGitStatus(output: string): GitFileStatus {
  const changes: FileChange[] = [];
  const conflicts: string[] = [];
  const untracked: string[] = [];
  const fields = output.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    if (field.length < 4) continue;
    const code = field.slice(0, 2);
    const path = field.slice(3);
    if (code === "!!") continue;
    if (CONFLICT_CODES.has(code)) conflicts.push(path);
    changes.push({ path, kind: changeKind(code) });
    if (code === "??") untracked.push(path);
    if (code.includes("R") || code.includes("C")) i++;
  }
  return { changes, conflicts, untracked };
}

export async function readGitStatus(cwd: string, signal: AbortSignal): Promise<GitFileStatus> {
  return parseGitStatus(
    await runGit(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], signal),
  );
}

/** Up to `MAX_COMMITS` commits of `range`, newest first, as the shared model has them. */
export async function logCommits(
  cwd: string,
  range: string,
  signal: AbortSignal,
): Promise<Commit[]> {
  const output = await runGit(
    cwd,
    ["log", "-z", "--no-show-signature", GIT_LOG_FORMAT, `--max-count=${MAX_COMMITS}`, range, "--"],
    signal,
  );
  return parseGitLog(output).map((commit) => ({
    id: commit.commitId,
    subject: subjectOf(commit.message),
    createdAt: isoTime(commit.createdAt),
    conflicted: false,
  }));
}

export async function countCommits(
  cwd: string,
  range: string,
  signal: AbortSignal,
): Promise<number> {
  return Number((await runGit(cwd, ["rev-list", "--count", range, "--"], signal)).trim()) || 0;
}

function nativeStatus(
  hasHead: boolean,
  conflicts: boolean,
  tracking: GitRemoteBranch | null,
  triangular: boolean,
  counts: number[] | null,
): Branch["status"] {
  if (conflicts) return "conflicted";
  if (!hasHead) return "empty";
  if (triangular) return "unknown";
  if (!tracking) return "unpushed";
  if (counts?.[0] === 0 && counts?.[1] === 0) return "pushed";
  if (counts?.[0] === 0) return "behind";
  if (counts?.[1] === 0) return "ahead";
  return "diverged";
}

function nativePush(
  status: Branch["status"],
  hasHead: boolean,
  remote: string | null,
): Branch["push"] {
  if (!hasHead || !remote) return "none";
  if (status === "diverged") return "force";
  return status === "ahead" || status === "unpushed" ? "push" : "none";
}

export async function readGitDetails(checkout: Checkout, signal: AbortSignal): Promise<GitDetails> {
  if (checkout.branch === null) throw new CommandFailedError("The checkout has no branch.");
  const { path, head } = checkout;
  const [{ target, tracking, pushRemote, configuredTracking }, status] = await Promise.all([
    remotes(path, checkout.branch, signal),
    readGitStatus(path, signal),
  ]);
  const base =
    head && target ? await optionalGit(path, ["merge-base", head, target.head], signal) : null;
  return { checkout, target, tracking, pushRemote, configuredTracking, base, status };
}

/** When the repository last fetched, from `FETCH_HEAD`, which every fetch rewrites. */
async function lastFetched(commonDir: string): Promise<string | null> {
  return stat(join(commonDir, "FETCH_HEAD")).then(
    (found) => found.mtime.toISOString(),
    () => null,
  );
}

async function readTarget(details: GitDetails, signal: AbortSignal): Promise<Target | null> {
  const { target, base, checkout } = details;
  if (!target) return null;
  const [behind, baseCommit, fetched] = await Promise.all([
    checkout.head ? countCommits(checkout.path, `${checkout.head}..${target.head}`, signal) : 0,
    base
      ? runGit(checkout.path, ["show", "-s", "--format=%B", base, "--"], signal).then(subjectOf)
      : null,
    lastFetched(checkout.commonDir),
  ]);
  return {
    ref: `${target.remote}/${target.name}`,
    head: target.head,
    behind,
    base: base && baseCommit !== null ? { id: base, subject: baseCommit } : null,
    lastFetched: fetched,
  };
}

async function readBranch(details: GitDetails, signal: AbortSignal): Promise<Branch> {
  const { checkout, tracking, pushRemote, configuredTracking, base, status } = details;
  const { path, head } = checkout;
  const own = head ? (base ? `${base}..${head}` : head) : null;
  const compared = head && tracking ? `${head}...${tracking.head}` : null;
  const [commits, total, upstreamCommits, equivalents, counts] = await Promise.all([
    own ? logCommits(path, own, signal) : [],
    own ? countCommits(path, own, signal) : 0,
    head && tracking ? logCommits(path, `${head}..${tracking.head}`, signal) : [],
    compared
      ? runGit(path, ["rev-list", "--left-right", "--cherry-mark", compared, "--"], signal)
      : null,
    compared
      ? runGit(path, ["rev-list", "--left-right", "--count", compared, "--"], signal).then(
          (output) => output.trim().split(/\s+/).map(Number),
        )
      : null,
  ]);
  const triangular = Boolean(
    configuredTracking && pushRemote && configuredTracking.remote !== pushRemote,
  );
  const branchStatus = nativeStatus(
    head !== null,
    status.conflicts.length > 0,
    tracking,
    triangular,
    counts,
  );
  return {
    name: checkout.branch!,
    head,
    remote: tracking ? { ref: `${tracking.remote}/${tracking.name}`, name: tracking.name } : null,
    status: branchStatus,
    push: nativePush(branchStatus, head !== null, pushRemote),
    ahead: counts?.[0] ?? 0,
    behind: counts?.[1] ?? 0,
    newUpstream: equivalents === null ? 0 : countSides(equivalents).remote,
    reviewId: null,
    commits,
    moreCommits: Math.max(0, total - commits.length),
    upstreamCommits,
  };
}

/** Files sorted by path, so both providers list the same edits the same way. */
export function byPath(changes: readonly FileChange[]): FileChange[] {
  return [...changes].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export async function readGitWorkspace(
  checkout: Checkout,
  signal: AbortSignal,
): Promise<WorkspaceValue> {
  const details = await readGitDetails(checkout, signal);
  const [branch, target] = await Promise.all([
    readBranch(details, signal),
    readTarget(details, signal),
  ]);
  const changes = byPath(details.status.changes);
  return {
    provider: "git",
    path: checkout.path,
    commonDir: checkout.commonDir,
    checkedOut: branch.name,
    github: githubHome(checkout.remotes),
    uncommitted: changes.slice(0, MAX_UNCOMMITTED),
    moreUncommitted: Math.max(0, changes.length - MAX_UNCOMMITTED),
    conflicted: details.status.conflicts.slice(0, MAX_UNCOMMITTED),
    stacks: [{ key: branch.name, branches: [branch], assigned: [] }],
    target,
  };
}

const DIFF_OPTIONS = [
  "-c",
  "core.quotePath=false",
  "diff",
  "--no-color",
  "--no-ext-diff",
  "--src-prefix=a/",
  "--dst-prefix=b/",
  "--submodule=short",
  "-M",
];

/**
 * One commit's patches from git. The reader's git config can change the
 * headers the parser reads paths from, so they are pinned.
 */
export async function showCommit(
  cwd: string,
  commitId: string,
  signal: AbortSignal,
): Promise<PatchSet> {
  const output = await runGit(
    cwd,
    [
      "-c",
      "core.quotePath=false",
      "show",
      "--format=",
      "--no-color",
      "--no-ext-diff",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--submodule=short",
      "-M",
      "--diff-merges=first-parent",
      commitId,
      "--",
    ],
    signal,
  );
  return patchesFromGit(output, MAX_PATCH_CHARS);
}

/** Staged, unstaged, and untracked changes against HEAD, or one commit's. */
export async function readGitPatches(
  checkout: Checkout,
  source: PatchSource,
  signal: AbortSignal,
): Promise<PatchSet> {
  const cwd = checkout.path;
  if (source.kind === "commit") return showCommit(cwd, source.commitId, signal);
  const status = await readGitStatus(cwd, signal);
  const empty = checkout.head
    ? null
    : (await runGit(cwd, ["hash-object", "-t", "tree", "--stdin"], signal, { input: "" })).trim();
  let output = await runGit(cwd, [...DIFF_OPTIONS, checkout.head ?? empty!, "--"], signal);
  for (const path of status.untracked) {
    if (output.length > MAX_PATCH_CHARS) break;
    const diff = await runGitCommand(
      cwd,
      [...DIFF_OPTIONS, "--no-index", "--", "/dev/null", path],
      signal,
    );
    if (diff.code !== 0 && diff.code !== 1)
      throw new CommandFailedError(diff.stderr.trim() || "The untracked file could not be read.");
    output += diff.stdout;
  }
  return patchesFromGit(output, MAX_PATCH_CHARS);
}
