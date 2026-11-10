/**
 * The GitButler workspace provider's reads: `but status -u --json` mapped
 * into the same shape the plain-git provider reads, with git filling in what
 * `but` does not say (each branch's remote, and how far ahead and behind it
 * is). Ported from the workspace and patch reads in
 * `plugins/gitbutler/src/host/host.ts`.
 */
import {
  MAX_COMMITS,
  MAX_UNCOMMITTED,
  type Branch,
  type Commit,
  type PatchSource,
  type Target,
  type WorkspaceValue,
} from "../core/change.ts";
import { githubHome } from "../core/ids.ts";
import type { Checkout } from "./checkout.ts";
import { CommandFailedError, optionalGit, runBut, runGit } from "./cli.ts";
import { byPath, MAX_PATCH_CHARS, showCommit } from "./git-workspace.ts";
import {
  isoTime,
  parseWorkspace,
  patchesFor,
  subjectOf,
  uncommittedKinds,
  type ButBoard,
  type ButBranch,
  type ButCommit,
  type PatchSet,
} from "./parse.ts";
import { compareWithRemotes, trackingRefs } from "./upstream.ts";

function commitOf(commit: ButCommit): Commit {
  return {
    id: commit.commitId,
    subject: subjectOf(commit.message),
    createdAt: isoTime(commit.createdAt),
    conflicted: commit.conflicted,
  };
}

/** `refs/remotes/origin/scott/x` as the ref `origin/scott/x` and the remote's name `scott/x`. */
function remoteOf(ref: string | undefined): Branch["remote"] {
  const rest = ref?.startsWith("refs/remotes/") ? ref.slice("refs/remotes/".length) : null;
  const slash = rest?.indexOf("/") ?? -1;
  if (!rest || slash < 1 || slash === rest.length - 1) return null;
  return { ref: rest, name: rest.slice(slash + 1) };
}

/** Commits on each side of `branch...remote`, which `but status` does not count. */
async function aheadBehind(
  cwd: string,
  name: string,
  remote: string,
  signal: AbortSignal,
): Promise<[number, number]> {
  const output = await runGit(
    cwd,
    ["rev-list", "--left-right", "--count", `refs/heads/${name}...${remote}`, "--"],
    signal,
  ).catch(() => null);
  const [ahead = 0, behind = 0] = output?.trim().split(/\s+/).map(Number) ?? [];
  return [ahead, behind];
}

function branchOf(branch: ButBranch, remote: string | undefined, counts: [number, number]): Branch {
  return {
    name: branch.name,
    head: branch.commits[0]?.commitId ?? null,
    remote: remoteOf(remote),
    status: branch.status,
    push: branch.push,
    ahead: remote ? counts[0] : 0,
    behind: remote ? counts[1] : 0,
    newUpstream: branch.newUpstream,
    reviewId: branch.reviewId,
    commits: branch.commits.slice(0, MAX_COMMITS).map(commitOf),
    moreCommits: Math.max(0, branch.commits.length - MAX_COMMITS),
    upstreamCommits: branch.upstreamCommits.slice(0, MAX_COMMITS).map(commitOf),
  };
}

/**
 * The target's name. `but` 0.23 records it as `refs/heads/<name>` on the
 * push remote, older versions as `refs/remotes/<remote>/<name>`; without
 * either, it is `origin`'s default branch.
 */
async function targetRef(cwd: string, signal: AbortSignal): Promise<string> {
  const settings =
    (await optionalGit(
      cwd,
      ["config", "--get-regexp", "^gitbutler\\.project\\.(targetref|pushremote)$"],
      signal,
    )) ?? "";
  const setting = (key: string) =>
    settings
      .split("\n")
      .find((line) => line.startsWith(`${key} `))
      ?.slice(key.length + 1)
      .trim() ?? "";
  const configured = setting("gitbutler.project.targetref");
  if (configured.startsWith("refs/remotes/")) return configured.slice("refs/remotes/".length);
  if (configured.startsWith("refs/heads/")) {
    const remote = setting("gitbutler.project.pushremote") || "origin";
    return `${remote}/${configured.slice("refs/heads/".length)}`;
  }
  const fallback = await optionalGit(
    cwd,
    ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"],
    signal,
  );
  return fallback?.replace(/^refs\/remotes\//, "") ?? "target";
}

async function targetOf(cwd: string, board: ButBoard, signal: AbortSignal): Promise<Target | null> {
  if (!board.upstream) return null;
  return {
    ref: await targetRef(cwd, signal),
    head: board.upstream.latest?.commitId ?? null,
    behind: board.upstream.behind,
    base: board.base ? { id: board.base.commitId, subject: subjectOf(board.base.message) } : null,
    lastFetched: isoTime(board.upstream.lastFetched),
  };
}

/** The workspace `payload` (`but status -u --json`) describes, with git's comparison added. */
export async function workspaceFromStatus(
  checkout: Checkout,
  payload: unknown,
  signal: AbortSignal,
): Promise<WorkspaceValue> {
  const cwd = checkout.path;
  const parsed = parseWorkspace(payload);
  const names = parsed.stacks.flatMap((stack) => stack.branches.map((branch) => branch.name));
  const tracking = await trackingRefs(cwd, names, signal).catch((error: unknown) => {
    if (signal.aborted) throw error;
    return new Map<string, string>();
  });
  const [board, counts, target] = await Promise.all([
    // Without the comparison the branches keep GitButler's own labels.
    compareWithRemotes(cwd, parsed, signal, tracking).catch((error: unknown) => {
      if (signal.aborted) throw error;
      return parsed;
    }),
    Promise.all(
      names.map(async (name) => {
        const remote = tracking.get(name);
        const counts: [number, number] = remote
          ? await aheadBehind(cwd, name, remote, signal)
          : [0, 0];
        return [name, counts] as const;
      }),
    ).then((entries) => new Map(entries)),
    targetOf(cwd, parsed, signal),
  ]);
  const unassigned = byPath(board.unassignedChanges);
  const assigned = board.stacks.map((stack) => byPath(stack.assignedChanges));
  const overflow = [unassigned, ...assigned].reduce(
    (sum, list) => sum + Math.max(0, list.length - MAX_UNCOMMITTED),
    0,
  );
  return {
    provider: "gitbutler",
    path: checkout.path,
    commonDir: checkout.commonDir,
    checkedOut: null,
    github: githubHome(checkout.remotes),
    uncommitted: unassigned.slice(0, MAX_UNCOMMITTED),
    moreUncommitted: overflow,
    conflicted: board.conflictedFiles.slice(0, MAX_UNCOMMITTED),
    stacks: board.stacks.map((stack, index) => ({
      key: stack.key,
      branches: stack.branches.map((branch) =>
        branchOf(branch, tracking.get(branch.name), counts.get(branch.name) ?? [0, 0]),
      ),
      assigned: assigned[index]!.slice(0, MAX_UNCOMMITTED),
    })),
    target,
  };
}

/** One call carries the whole workspace. `-u` attaches the upstream commits not integrated yet. */
export async function readButWorkspace(
  checkout: Checkout,
  signal: AbortSignal,
): Promise<WorkspaceValue> {
  const payload = await runBut(checkout.path, ["status", "-u"], signal);
  return workspaceFromStatus(checkout, payload, signal);
}

export async function readButPatches(
  checkout: Checkout,
  source: PatchSource,
  signal: AbortSignal,
): Promise<PatchSet> {
  const cwd = checkout.path;
  if (source.kind === "uncommitted") {
    const [payload, status] = await Promise.all([
      runBut(cwd, ["diff"], signal),
      // Only the kinds come from here, so the diff still shows without them.
      runBut(cwd, ["status"], signal).catch((error: unknown) => {
        if (signal.aborted) throw error;
        return null;
      }),
    ]);
    return patchesFor(payload, MAX_PATCH_CHARS, status ? uncommittedKinds(status) : undefined);
  }
  // `but diff` resolves only workspace commits. Any other commit is plain git.
  try {
    return patchesFor(await runBut(cwd, ["diff", source.commitId], signal), MAX_PATCH_CHARS);
  } catch (error) {
    if (signal.aborted || !(error instanceof CommandFailedError)) throw error;
  }
  return showCommit(cwd, source.commitId, signal);
}
