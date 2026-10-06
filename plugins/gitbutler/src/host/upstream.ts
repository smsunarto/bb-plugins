import type { Branch, Workspace } from "../shared/schema.ts";
import { runGit } from "./cli.ts";

/**
 * Splits a branch's upstream commits into the ones it lacks and the old
 * copies of its own work, which git can tell apart and `but status` cannot.
 *
 * `but status` reports a branch that is only behind its remote as needing a
 * force push, the same as one that has truly diverged. A force push there
 * deletes every remote commit and sends nothing, so the panel has to know
 * which it is. And after a rebase the remote still holds the pre-rebase
 * copies of the branch's commits: they list as upstream, but replacing them
 * loses nothing, and pulling them would replay the branch onto itself.
 */
export async function compareWithRemotes(
  cwd: string,
  workspace: Workspace,
  signal: AbortSignal,
): Promise<Workspace> {
  const behind = workspace.stacks
    .flatMap((stack) => stack.branches)
    .filter((branch) => branch.upstreamCommits.length > 0);
  if (behind.length === 0) return workspace;
  const tracking = await trackingRefs(
    cwd,
    behind.map((branch) => branch.name),
    signal,
  );
  const sides = new Map<string, Sides>();
  await Promise.all(
    behind.map(async (branch) => {
      const remote = tracking.get(branch.name);
      if (remote === undefined) return;
      const output = await runGit(
        cwd,
        ["rev-list", "--left-right", "--cherry-mark", `refs/heads/${branch.name}...${remote}`],
        signal,
      ).catch(() => null);
      if (output !== null) sides.set(branch.name, countSides(output));
    }),
  );
  return {
    ...workspace,
    stacks: workspace.stacks.map((stack) => ({
      ...stack,
      branches: stack.branches.map((branch) => withSides(branch, sides.get(branch.name))),
    })),
  };
}

/**
 * Each branch's remote-tracking ref, as GitButler picks it: the upstream git
 * has configured for the branch, else the branch on the project's push
 * remote. A branch with neither, or whose ref does not exist, is left out:
 * guessing a remote could compare against the wrong one and hide its commits.
 */
export async function trackingRefs(
  cwd: string,
  names: readonly string[],
  signal: AbortSignal,
): Promise<Map<string, string>> {
  const tracking = new Map<string, string>();
  if (names.length === 0) return tracking;
  const pushRemote = await projectPushRemote(cwd, signal);
  const upstreams = await runGit(
    cwd,
    [
      "for-each-ref",
      "--format=%(refname)%00%(upstream)",
      ...names.map((name) => `refs/heads/${name}`),
    ],
    signal,
  );
  // A pattern also matches refs below it, so only exact names count.
  const upstreamOf = new Map(
    upstreams.split("\n").map((line) => {
      const [ref = "", upstream = ""] = line.split("\0");
      return [ref, upstream] as const;
    }),
  );
  const wanted = new Map<string, string>();
  for (const name of names) {
    const configured = upstreamOf.get(`refs/heads/${name}`) ?? "";
    const ref = configured || (pushRemote ? `refs/remotes/${pushRemote}/${name}` : "");
    if (ref !== "") wanted.set(name, ref);
  }
  if (wanted.size === 0) return tracking;
  const existing = new Set(
    (await runGit(cwd, ["for-each-ref", "--format=%(refname)", ...wanted.values()], signal)).split(
      "\n",
    ),
  );
  for (const [name, ref] of wanted) if (existing.has(ref)) tracking.set(name, ref);
  return tracking;
}

/** The remote GitButler pushes to: its own setting, else the target branch's remote. */
async function projectPushRemote(cwd: string, signal: AbortSignal): Promise<string | undefined> {
  const settings = await runGit(
    cwd,
    ["config", "--get-regexp", "^gitbutler\\.project\\.(pushremote|targetref)$"],
    signal,
  ).catch(() => "");
  const setting = (key: string) =>
    settings
      .split("\n")
      .find((line) => line.startsWith(`${key} `))
      ?.slice(key.length + 1)
      .trim();
  return (
    setting("gitbutler.project.pushremote") ||
    /^refs\/remotes\/([^/]+)\//.exec(setting("gitbutler.project.targetref") ?? "")?.[1]
  );
}

/**
 * What a pull would bring in from `ref`: the remote commits the branch has no
 * copy of, and the files they touch, renames as both of their paths.
 */
export async function incoming(
  cwd: string,
  branch: string,
  ref: string,
  signal: AbortSignal,
): Promise<{ commits: number; files: string[] }> {
  // NUL-separated, so git writes every path as it is, never C-quoted.
  const output = await runGit(
    cwd,
    [
      "log",
      "-z",
      "--right-only",
      // A merge's own changes, its conflict resolution included, count too.
      "--diff-merges=first-parent",
      "--cherry-pick",
      "--no-renames",
      "--name-only",
      "--format=%x01",
      `refs/heads/${branch}...${ref}`,
    ],
    signal,
  );
  let commits = 0;
  const files = new Set<string>();
  let afterHeader = false;
  for (const token of output.split("\0")) {
    if (token === "\x01") {
      commits++;
      afterHeader = true;
      continue;
    }
    // A commit's first path follows its header after a newline.
    const file = afterHeader && token.startsWith("\n") ? token.slice(1) : token;
    afterHeader = false;
    if (file !== "") files.add(file);
  }
  return { commits, files: [...files] };
}

/** Commits only the local branch has, and only the remote has, equivalents aside. */
export type Sides = { local: number; remote: number };

/** `rev-list --left-right --cherry-mark`: `<` local, `>` remote, `=` on both in some form. */
export function countSides(output: string): Sides {
  let local = 0;
  let remote = 0;
  for (const line of output.split("\n")) {
    if (line.startsWith("<")) local++;
    else if (line.startsWith(">")) remote++;
  }
  return { local, remote };
}

/**
 * A branch with nothing of its own on top of new remote commits is behind:
 * Pull is its only useful action, so it has nothing to push. One whose
 * remote holds only copies of its commits keeps its force push, and nothing
 * upstream is new.
 */
export function withSides(branch: Branch, sides: Sides | undefined): Branch {
  if (sides === undefined) return branch;
  const newUpstream = Math.min(sides.remote, branch.upstreamCommits.length);
  if (branch.status === "diverged" && sides.local === 0 && newUpstream > 0) {
    return { ...branch, status: "behind", push: "none", newUpstream };
  }
  return { ...branch, newUpstream };
}
