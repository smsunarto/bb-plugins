import type { ActionRisk, Branch, ButAction, ButActionResult } from "../shared/schema.ts";
import { upstreamLoss } from "../shared/upstream-loss.ts";
import { ButFailedError, runBut, runButAction, runGit } from "./cli.ts";
import {
  judgeBranchUpdate,
  namedBranch,
  parseWorkspace,
  pullCheck,
  uncommittedKinds,
} from "./parse.ts";
import { compareWithRemotes, incoming, trackingRefs } from "./upstream.ts";

type OneCommand = Exclude<ButAction, { kind: "pull" | "updateWorkspace" }>;

/**
 * The buttons that are one `but` command each, as argv. Branches are named,
 * not given by CLI id, because ids are reassigned on every `but` invocation.
 */
export function actionArgs(action: OneCommand): string[] {
  switch (action.kind) {
    case "push":
      return ["push", action.branch, ...(action.force ? ["--with-force"] : [])];
    case "land":
      // The panel asks before it calls this, so the CLI's own prompt is skipped.
      return ["land", action.branch, "--yes"];
    case "rename":
      return ["reword", action.branch, "-m", action.name];
    case "delete":
      // Not `but discard`, which can also discard files and commits.
      return ["branch", "delete", action.branch];
  }
}

const DONE: ButActionResult = { status: "done" };
const UP_TO_DATE: ButActionResult = { status: "upToDate" };

/**
 * Runs one write. Every write on a branch first checks, against a fresh
 * `but status`, that the name still means that branch. Pull and Delete then
 * return `confirm` instead of running when they found a risk beyond what the
 * reader accepted.
 */
export async function runAction(
  cwd: string,
  action: ButAction,
  signal: AbortSignal,
): Promise<ButActionResult> {
  if (action.kind === "updateWorkspace") return updateWorkspace(cwd, action.accepted, signal);
  // Fetched first, so the status read next knows the remote's latest commits.
  if (action.kind === "pull" || action.kind === "push") await fetchRemotes(cwd, signal);
  const status = await runBut(cwd, ["status", "-u"], signal);
  const branch = namedBranch(status, action.branch);
  if (action.kind === "pull") return pullBranch(cwd, status, branch, action.accepted, signal);
  if (action.kind === "push")
    await checkUpstreamLoss(cwd, status, branch, action.acceptedLoss, signal);
  if (action.kind === "delete") {
    const risk = {
      conflicted: [],
      overlapsUncommitted: await deleteTouchesUncommitted(cwd, status, branch, signal),
    };
    if (!accepts(action.accepted, risk)) return { status: "confirm", risk };
  }
  await runButAction(cwd, actionArgs(action), signal);
  return DONE;
}

/** Whether the reader agreed to at least every part of `risk`. */
function accepts(accepted: ActionRisk | null, risk: ActionRisk): boolean {
  return (
    risk.conflicted.every((name) => accepted?.conflicted.includes(name)) &&
    (!risk.overlapsUncommitted || accepted?.overlapsUncommitted === true)
  );
}

/**
 * `but pull --check` fetches every remote and changes nothing local, not even
 * the undo history. Both pulls start with it: `but branch update` never
 * fetches, and run against stale remote refs it quietly does nothing.
 */
async function fetchRemotes(cwd: string, signal: AbortSignal): Promise<unknown> {
  return (await runButAction(cwd, ["pull", "--check"], signal)).payload;
}

/** Files with uncommitted changes, which a rewrite of the files under them can conflict with. */
function uncommittedPaths(status: unknown): Set<string> {
  return new Set(uncommittedKinds(status).keys());
}

/**
 * Brings a branch's own remote commits into it with `but branch update`,
 * which rebases the local commits onto them. It reports success even when
 * it moves another branch's commits or leaves conflicts, and its preview
 * leaves uncommitted files out, so the panel checks all three first.
 */
async function pullBranch(
  cwd: string,
  status: unknown,
  branch: Branch,
  accepted: ActionRisk | null,
  signal: AbortSignal,
): Promise<ButActionResult> {
  if (branch.upstreamCommits.length === 0) return UP_TO_DATE;
  const ref = (await trackingRefs(cwd, [branch.name], signal)).get(branch.name);
  // Without the ref, every uncommitted file might be in the way.
  const brought = ref === undefined ? null : await incoming(cwd, branch.name, ref, signal);
  // The remote holds only old copies of the branch's commits: pulling them would duplicate them.
  if (brought?.commits === 0) return UP_TO_DATE;

  const preview = judgeBranchUpdate(
    status,
    (await runButAction(cwd, ["branch", "update", branch.name, "--dry-run"], signal)).payload,
  );
  const [move] = preview.moved;
  if (move) {
    throw new ButFailedError(
      `Pull stopped before changing anything: GitButler would move commits from ${move.from} into ${move.to || "an unnamed branch"}.`,
    );
  }
  const uncommitted = uncommittedPaths(status);
  const risk = {
    conflicted: preview.conflicted,
    overlapsUncommitted: brought
      ? brought.files.some((file) => uncommitted.has(file))
      : uncommitted.size > 0,
  };
  if (!accepts(accepted, risk)) return { status: "confirm", risk };
  await runButAction(cwd, ["branch", "update", branch.name], signal);
  return DONE;
}

/**
 * Whether uncommitted changes sit in files the branch's commits touch.
 * Deleting the branch takes those lines back out from under them, and
 * `but branch delete` then writes conflict markers into the files.
 */
async function deleteTouchesUncommitted(
  cwd: string,
  status: unknown,
  branch: Branch,
  signal: AbortSignal,
): Promise<boolean> {
  const uncommitted = uncommittedPaths(status);
  if (uncommitted.size === 0 || branch.commits.length === 0) return false;
  const touched = await runGit(
    cwd,
    [
      "log",
      "-z",
      "--no-walk=unsorted",
      // A merge's own changes, its conflict resolution included, count too.
      "--diff-merges=first-parent",
      "--no-renames",
      "--name-only",
      "--format=",
      ...branch.commits.map((commit) => commit.commitId),
    ],
    signal,
  );
  return touched.split("\0").some((file) => uncommitted.has(file));
}

/**
 * `but push` replaces the remote branch, without a lease unless the project
 * turned GitButler's force-push protection on. So right after the fetch, the
 * push stops when it would delete an upstream commit the reader did not
 * agree to, and the card redraws with it and asks.
 */
async function checkUpstreamLoss(
  cwd: string,
  status: unknown,
  branch: Branch,
  accepted: readonly string[],
  signal: AbortSignal,
): Promise<void> {
  const workspace = await compareWithRemotes(cwd, parseWorkspace(status, ""), signal);
  const stack = workspace.stacks.find((candidate) =>
    candidate.branches.some((entry) => entry.name === branch.name),
  )?.branches;
  const pushedWith = stack?.slice(stack.findIndex((entry) => entry.name === branch.name)) ?? [];
  const agreed = new Set(accepted);
  if (upstreamLoss(pushedWith).some((commit) => !agreed.has(commit))) {
    throw new ButFailedError(
      "Push stopped: the remote has commits this push would delete that you were not asked about. Look at them, then push again.",
    );
  }
}

/**
 * Rebases every applied branch onto the target branch's latest commits.
 * `but pull` fetches once more, so a commit pushed in the moment between the
 * check and the pull goes unchecked: `but pull` has no way to skip its fetch.
 */
async function updateWorkspace(
  cwd: string,
  accepted: ActionRisk | null,
  signal: AbortSignal,
): Promise<ButActionResult> {
  const check = pullCheck(await fetchRemotes(cwd, signal));
  if (check.upToDate) return UP_TO_DATE;
  // Per branch only: a branch that already holds a conflicted commit stays
  // listed, since the check cannot tell whether it gains another.
  const risk = { conflicted: check.conflicted, overlapsUncommitted: check.overlapsUncommitted };
  if (!accepts(accepted, risk)) return { status: "confirm", risk };
  await runButAction(cwd, ["pull"], signal);
  return DONE;
}
