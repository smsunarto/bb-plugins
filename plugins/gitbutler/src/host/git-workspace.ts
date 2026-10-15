import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  BaseCommit,
  Branch,
  Commit,
  FileChange,
  HostWorkspace,
  Patches,
  PatchSource,
} from "../shared/schema.ts";
import { ButFailedError, runGit, runGitCommand } from "./cli.ts";
import { readCheckoutHead } from "./history.ts";
import { readOrigin } from "./origin.ts";
import { parseGitLog, patchesFromGit } from "./parse.ts";
import { countSides } from "./upstream.ts";

const FORMAT = "--format=%H%x00%an%x00%aI%x00%B";
const MAX_PATCH_CHARS = 1_500_000;

export type GitCheckoutIdentity = {
  path: string;
  branch: string | null;
  head: string | null;
  origin: string | null;
  commonDir: string;
  kind: "git" | "gitbutler";
};

/** Workspace, edit, and other internal heads belong to GitButler's lifecycle. */
export function isGitButlerHead(ref: string | null): boolean {
  return ref?.startsWith("refs/heads/gitbutler/") ?? false;
}

export async function optionalGit(
  cwd: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<string | null> {
  const result = await runGitCommand(cwd, args, signal);
  if (result.code === 0) return result.stdout.trim() || null;
  if (result.code === 1) return null;
  throw new ButFailedError(result.stderr.trim() || "Git could not read this repository.");
}

export async function readGitCheckout(
  cwd: string,
  signal: AbortSignal,
): Promise<GitCheckoutIdentity> {
  const path = await realpath(cwd);
  const [ref, common, origin] = await Promise.all([
    optionalGit(path, ["symbolic-ref", "-q", "HEAD"], signal),
    runGit(path, ["rev-parse", "--git-common-dir"], signal),
    readOrigin(path, signal),
  ]);
  const branch = ref?.startsWith("refs/heads/") ? ref.slice(11) : null;
  const head = branch
    ? ((await readCheckoutHead(path, branch, signal))?.commitId ?? null)
    : await optionalGit(path, ["rev-parse", "--verify", "--quiet", "HEAD"], signal);
  return {
    path,
    branch,
    head,
    origin,
    commonDir: await realpath(resolve(path, common.trim())),
    kind: isGitButlerHead(ref) ? "gitbutler" : "git",
  };
}

export type GitRemoteBranch = { remote: string; name: string; ref: string; head: string };
export type GitWorkspaceDetails = {
  identity: GitCheckoutIdentity;
  target: GitRemoteBranch | null;
  tracking: GitRemoteBranch | null;
  pushRemote: string | null;
  configuredTracking: { remote: string; name: string } | null;
  base: string | null;
  workspace: HostWorkspace;
};

async function setting(cwd: string, key: string, signal: AbortSignal): Promise<string | null> {
  return optionalGit(cwd, ["config", "--get", key], signal);
}

async function remoteBranch(
  cwd: string,
  ref: string | null,
  signal: AbortSignal,
): Promise<GitRemoteBranch | null> {
  if (!ref?.startsWith("refs/remotes/")) return null;
  const rest = ref.slice(13);
  const slash = rest.indexOf("/");
  if (slash < 1 || slash === rest.length - 1) return null;
  const head = await optionalGit(
    cwd,
    ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    signal,
  );
  return head ? { remote: rest.slice(0, slash), name: rest.slice(slash + 1), ref, head } : null;
}

/** Per-branch configuration stays meaningful even before its upstream ref is fetched. */
async function branchSettings(cwd: string, branch: string | null, signal: AbortSignal) {
  if (!branch)
    return { configuredPush: null, branchRemote: null, branchMerge: null, trackingRef: null };
  const [configuredPush, branchRemote, branchMerge, tracked] = await Promise.all([
    setting(cwd, `branch.${branch}.pushRemote`, signal),
    setting(cwd, `branch.${branch}.remote`, signal),
    setting(cwd, `branch.${branch}.merge`, signal),
    runGit(
      cwd,
      ["for-each-ref", "--format=%(refname)%00%(upstream)", `refs/heads/${branch}`],
      signal,
    ),
  ]);
  const trackingRef =
    tracked
      .split("\n")
      .map((line) => line.split("\0"))
      .find(([name]) => name === `refs/heads/${branch}`)?.[1] || null;
  return { configuredPush, branchRemote, branchMerge, trackingRef };
}

async function remotes(cwd: string, branch: string | null, signal: AbortSignal) {
  const [configuredTarget, defaultPush, configuredBranch, names] = await Promise.all([
    setting(cwd, "gitbutler.project.targetref", signal),
    setting(cwd, "remote.pushDefault", signal),
    branchSettings(cwd, branch, signal),
    runGit(cwd, ["remote"], signal),
  ]);
  const { configuredPush, branchRemote, branchMerge, trackingRef } = configuredBranch;
  const available = names.trim().split("\n").filter(Boolean);
  const defaultRemote = available.includes("origin")
    ? "origin"
    : available.length === 1
      ? available[0]!
      : null;
  const projectPush = await setting(cwd, "gitbutler.project.pushremote", signal);
  const pushRemote =
    configuredPush ||
    defaultPush ||
    projectPush ||
    (branchRemote !== "." ? branchRemote : null) ||
    defaultRemote;
  const targetRemote = configuredTarget?.startsWith("refs/remotes/")
    ? configuredTarget.slice(13).split("/")[0]!
    : defaultRemote;
  const defaultTarget = targetRemote
    ? await optionalGit(cwd, ["symbolic-ref", "-q", `refs/remotes/${targetRemote}/HEAD`], signal)
    : null;
  const [target, tracking] = await Promise.all([
    remoteBranch(cwd, configuredTarget || defaultTarget, signal),
    remoteBranch(
      cwd,
      trackingRef || (branch && pushRemote ? `refs/remotes/${pushRemote}/${branch}` : null),
      signal,
    ),
  ]);
  const configuredTracking =
    branchRemote && branchMerge?.startsWith("refs/heads/")
      ? { remote: branchRemote, name: branchMerge.slice(11) }
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
    const conflict = ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(code);
    if (conflict) conflicts.push(path);
    const kind = changeKind(code);
    changes.push({ path, kind });
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

async function commits(cwd: string, range: string, signal: AbortSignal): Promise<Commit[]> {
  return parseGitLog(
    await runGit(cwd, ["log", "-z", "--no-show-signature", FORMAT, range, "--"], signal),
  ).map((commit) => Object.assign(commit, { changeId: null, conflicted: false }));
}

async function readComparison(
  path: string,
  head: string | null,
  tracking: GitRemoteBranch | null,
  signal: AbortSignal,
) {
  if (!head || !tracking) return { remoteCommits: [], sides: null, pushSides: null };
  const range = `${head}...${tracking.head}`;
  const [remoteCommits, equivalents, counts] = await Promise.all([
    commits(path, `${head}..${tracking.head}`, signal),
    runGit(path, ["rev-list", "--left-right", "--cherry-mark", range], signal),
    runGit(path, ["rev-list", "--left-right", "--count", range], signal),
  ]);
  return {
    remoteCommits,
    sides: countSides(equivalents),
    pushSides: counts.trim().split(/\s+/).map(Number),
  };
}

export async function readGitWorkspaceDetails(
  repository: { path: string; name: string; key: string },
  signal: AbortSignal,
): Promise<GitWorkspaceDetails> {
  const { path } = repository;
  const identity = await readGitCheckout(path, signal);
  const [{ target, tracking, pushRemote, configuredTracking }, status] = await Promise.all([
    remotes(path, identity.branch, signal),
    readGitStatus(path, signal),
  ]);
  const base =
    identity.head && target
      ? await optionalGit(path, ["merge-base", identity.head, target.head], signal)
      : null;
  const own =
    identity.head && identity.branch
      ? await commits(path, base ? `${base}..${identity.head}` : identity.head, signal)
      : [];
  const { remoteCommits, sides, pushSides } = await readComparison(
    path,
    identity.head,
    tracking,
    signal,
  );
  const triangular = configuredTracking && pushRemote && configuredTracking.remote !== pushRemote;
  const branchStatus = nativeStatus(
    identity.head !== null,
    status.conflicts.length > 0,
    tracking,
    Boolean(triangular),
    pushSides,
  );
  const branch: Branch | null = identity.branch
    ? {
        name: identity.branch,
        status: branchStatus,
        rawStatus: triangular
          ? "The push remote differs from this branch's upstream. Choose a matching upstream before pushing here."
          : `Git: ${branchStatus}`,
        push: nativePush(branchStatus, identity.head !== null, pushRemote),
        reviewId: null,
        ci: null,
        commits: own,
        upstreamCommits: remoteCommits,
        newUpstream: sides?.remote ?? 0,
      }
    : null;
  let baseCommit: BaseCommit | null = null;
  const baseId = identity.branch ? base : identity.head;
  if (baseId)
    baseCommit =
      parseGitLog(
        await runGit(
          path,
          ["log", "-z", "--no-show-signature", FORMAT, "--max-count=1", baseId, "--"],
          signal,
        ),
      )[0] ?? null;
  const behind =
    target && base
      ? Number(
          (
            await runGit(path, ["rev-list", "--count", `${identity.head}..${target.head}`], signal)
          ).trim(),
        )
      : 0;
  const workspace: HostWorkspace = {
    state: "ready",
    reason: null,
    repositoryKey: repository.key,
    repoName: repository.name,
    unassignedChanges: status.changes,
    stacks: branch ? [{ key: branch.name, branches: [branch], assignedChanges: [] }] : [],
    base: baseCommit,
    upstream: target
      ? {
          behind,
          lastFetched: null,
          latest: {
            commitId: target.head,
            subject: (
              await runGit(path, ["show", "-s", "--format=%s", target.head, "--"], signal)
            ).trimEnd(),
          },
        }
      : null,
    conflictedFiles: status.conflicts,
    checkoutIdentity: identity,
  };
  return { identity, target, tracking, pushRemote, configuredTracking, base, workspace };
}

export async function readGitWorkspace(
  repository: { path: string; name: string; key: string },
  signal: AbortSignal,
): Promise<HostWorkspace> {
  return (await readGitWorkspaceDetails(repository, signal)).workspace;
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

export async function readGitPatches(
  cwd: string,
  source: PatchSource,
  signal: AbortSignal,
): Promise<Patches> {
  if (source.kind === "commit") {
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
        source.commitId,
        "--",
      ],
      signal,
    );
    return patchesFromGit(output, MAX_PATCH_CHARS);
  }
  const [identity, status] = await Promise.all([
    readGitCheckout(cwd, signal),
    readGitStatus(cwd, signal),
  ]);
  const empty = identity.head
    ? null
    : (await runGit(cwd, ["hash-object", "-t", "tree", "--stdin"], signal)).trim();
  let output = await runGit(cwd, [...DIFF_OPTIONS, identity.head || empty!, "--"], signal);
  for (const path of status.untracked) {
    const diff = await runGitCommand(
      cwd,
      [...DIFF_OPTIONS, "--no-index", "--", "/dev/null", path],
      signal,
    );
    if (diff.code !== 0 && diff.code !== 1)
      throw new ButFailedError(diff.stderr.trim() || "The untracked file could not be read.");
    output += diff.stdout;
    if (output.length > MAX_PATCH_CHARS) break;
  }
  return patchesFromGit(output, MAX_PATCH_CHARS);
}
