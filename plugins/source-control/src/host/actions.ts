/**
 * The GitButler workspace provider's writes. Ported from
 * `plugins/gitbutler/src/host/actions.ts` (push, the workspace pull, land
 * and delete; rename and the per-branch pull stay in that plugin).
 * Branches are named, not given by CLI id, because ids are reassigned on
 * every `but` invocation. A write that finds a risk the reader did not
 * accept returns `confirm` and changes nothing; a refusal throws.
 */
import type { ActionRisk, VcsAction, VcsResult } from "../core/change.ts";
import { CommandFailedError, runBut, runButAction, runGit } from "./cli.ts";
import {
  checkedTarget,
  namedBranch,
  parseWorkspace,
  pullCheck,
  uncommittedKinds,
  type ButBranch,
} from "./parse.ts";
import { compareWithRemotes, upstreamLoss } from "./upstream.ts";

const DONE: VcsResult = { status: "done" };
const UP_TO_DATE: VcsResult = { status: "upToDate" };

/** Runs one write in the GitButler workspace at `cwd`. */
export async function runButWrite(
  cwd: string,
  action: VcsAction,
  signal: AbortSignal,
): Promise<VcsResult> {
  if (action.kind === "pull") return updateWorkspace(cwd, action.accepted, signal);
  if (action.kind === "delete") return deleteBranch(cwd, action, signal);
  // Fetched first, so the status read next knows the remote's latest commits.
  const fetched = await fetchRemotes(cwd, signal);
  const status = await runBut(cwd, ["status", "-u"], signal);
  const branch = namedBranch(status, action.branch);
  if (action.kind === "land") return land(cwd, fetched, status, branch, action, signal);
  const loss = await unacceptedLoss(cwd, status, branch, action.acceptedLoss, signal);
  if (loss !== null) return { status: "confirm", risk: null, loss };
  await runButAction(
    cwd,
    ["push", action.branch, ...(action.force ? ["--with-force"] : [])],
    signal,
  );
  return DONE;
}

/**
 * Deletes a branch with `but branch delete`, not `but discard`, which can also
 * discard files and commits. Asks first when the branch's commits touch files
 * with uncommitted changes: deleting it takes those lines back out from under
 * them, and `but branch delete` then writes conflict markers into the files.
 */
async function deleteBranch(
  cwd: string,
  action: Extract<VcsAction, { kind: "delete" }>,
  signal: AbortSignal,
): Promise<VcsResult> {
  const status = await runBut(cwd, ["status", "-u"], signal);
  const branch = namedBranch(status, action.branch);
  const risk: ActionRisk = {
    conflicted: [],
    overlapsUncommitted: await deleteTouchesUncommitted(cwd, status, branch, signal),
  };
  if (!accepts(action.accepted, risk)) return { status: "confirm", risk, loss: null };
  await runButAction(cwd, ["branch", "delete", action.branch], signal);
  return DONE;
}

/** Whether uncommitted changes sit in files the branch's commits touch. */
async function deleteTouchesUncommitted(
  cwd: string,
  status: unknown,
  branch: ButBranch,
  signal: AbortSignal,
): Promise<boolean> {
  const uncommitted = uncommittedKinds(status);
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

type Land = Extract<VcsAction, { kind: "land" }>;
type CheckedTarget = { name: string; commitId: string };

/**
 * Lands a branch as one commit on top of the target, as a squash merge does.
 * `but land` has no squash of its own, so a branch of several commits is
 * squashed first, into one with the reader's message. `but land` also
 * fast-forwards the target only when the branch sits on its newest commit,
 * and otherwise lands a merge commit, so a branch behind the target is pulled
 * up to it first.
 *
 * Nothing that already ran is taken back when a later step fails: `but undo`
 * would also take back whatever uncommitted changes were made since. The
 * error says what ran instead.
 */
async function land(
  cwd: string,
  fetched: unknown,
  status: unknown,
  branch: ButBranch,
  action: Land,
  signal: AbortSignal,
): Promise<VcsResult> {
  const refusal = landRefusal(status, branch, action.message);
  if (refusal !== null)
    throw new CommandFailedError(`Land stopped before changing anything: ${refusal}`);
  const target = checkedTarget(fetched);
  const pulls = (await behind(cwd, branch, target.commitId, signal)) > 0;
  if (pulls) {
    const risk = pullRisk(fetched, branch, target);
    if (!accepts(action.accepted, risk)) return { status: "confirm", risk, loss: null };
    await runButAction(cwd, ["pull"], signal);
  }
  let squashed = false;
  try {
    const landing = pulls ? await afterPull(cwd, branch, action, target, signal) : branch;
    if (action.message !== null) {
      // Joined to its flag, so a message starting with a dash is not read as one.
      await runButAction(cwd, ["squash", landing.name, `--message=${action.message}`], signal);
      squashed = true;
    }
    // The reader confirmed before this was called, so the CLI's own prompt is skipped.
    await runButAction(cwd, ["land", landing.name, "--yes"], signal);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (pulls) error.message = `Land pulled the workspace, then stopped: ${error.message}`;
    // `but land` can fail after its push went out, so the target may have the commit.
    if (squashed) {
      error.message += ` ${branch.name} is now one squashed commit. If the target does not have it yet, land it again.`;
    }
    throw error;
  }
  return DONE;
}

/** How many of the target's commits the branch lacks. */
async function behind(
  cwd: string,
  branch: ButBranch,
  target: string,
  signal: AbortSignal,
): Promise<number> {
  const tip = branch.commits[0]!.commitId;
  return Number(await runGit(cwd, ["rev-list", "--count", `${tip}..${target}`], signal));
}

/**
 * What the pull that brings the branch up to the target would also do. It
 * refuses when the branch itself would conflict, since `but land` refuses a
 * conflicted commit.
 */
function pullRisk(fetched: unknown, branch: ButBranch, target: CheckedTarget): ActionRisk {
  const check = pullCheck(fetched);
  if (check.conflicted.includes(branch.name)) {
    throw new CommandFailedError(
      `Land stopped before changing anything: ${branch.name} conflicts with the new commits on ${target.name}. Pull the workspace, resolve the conflicts, then land it.`,
    );
  }
  return { conflicted: check.conflicted, overlapsUncommitted: check.overlapsUncommitted };
}

/**
 * The branch as the pull rebased it, once it is still the one the reader
 * confirmed. The pull drops commits the target already has, and a squash
 * message written for them would describe changes the commit lacks.
 */
async function afterPull(
  cwd: string,
  before: ButBranch,
  action: Land,
  target: CheckedTarget,
  signal: AbortSignal,
): Promise<ButBranch> {
  const status = await runBut(cwd, ["status", "-u"], signal);
  // GitButler drops a branch from the workspace once the target has its changes.
  const pulled = namedBranch(status, before.name);
  const changed = changedCommits(pulled.name, before.commits.length, pulled.commits.length);
  if (changed !== null) throw new CommandFailedError(changed);
  const refusal = landRefusal(status, pulled, action.message);
  if (refusal !== null) throw new CommandFailedError(refusal);
  const still = await behind(cwd, pulled, target.commitId, signal);
  if (still > 0) {
    throw new CommandFailedError(
      `${pulled.name} is still ${still === 1 ? "a commit" : `${still} commits`} behind ${target.name}, so \`but land\` would merge it. Land it again.`,
    );
  }
  return pulled;
}

/** Why a branch that had `had` commits before the pull and `has` after can't land as confirmed. */
function changedCommits(name: string, had: number, has: number): string | null {
  if (has === had) return null;
  if (has === 0) return `the target already has all of ${name}'s commits. Nothing is left to land.`;
  if (has > had)
    return `${name} has ${has} commits after the pull, where it had ${had}. Land it again.`;
  const gone = had - has;
  return `the target already had ${gone === 1 ? "one" : gone} of ${name}'s ${had} commits, so the pull took ${gone === 1 ? "it" : "them"} out. Land it again to land the rest.`;
}

/**
 * Why the branch, as the fresh status has it, can't land as the reader
 * confirmed it. A message was written for the several commits they saw.
 */
function landRefusal(status: unknown, branch: ButBranch, message: string | null): string | null {
  const stack = parseWorkspace(status).stacks.find((entry) =>
    entry.branches.some((candidate) => candidate.name === branch.name),
  );
  if (stack?.branches.at(-1)?.name !== branch.name) {
    return `${branch.name} has a branch below it now, and only the lowest branch of a stack can land.`;
  }
  if (branch.commits.length === 0) return `${branch.name} has no commits to land.`;
  if (branch.commits.some((commit) => commit.conflicted)) {
    return `${branch.name} has conflicted commits, which \`but land\` refuses.`;
  }
  const several = branch.commits.length > 1;
  if (several && message === null) {
    return `${branch.name} has more commits than when you chose Land. Land it again to write their squashed message.`;
  }
  if (!several && message !== null) {
    return `${branch.name} is down to one commit since you chose Land. Land it again to land that commit as it is.`;
  }
  return null;
}

/** Whether the reader agreed to at least every part of `risk`. */
export function accepts(accepted: ActionRisk | null, risk: ActionRisk): boolean {
  return (
    risk.conflicted.every((name) => accepted?.conflicted.includes(name)) &&
    (!risk.overlapsUncommitted || accepted?.overlapsUncommitted === true)
  );
}

/**
 * `but pull --check` fetches every remote and changes nothing local, not even
 * the undo history.
 */
async function fetchRemotes(cwd: string, signal: AbortSignal): Promise<unknown> {
  return (await runButAction(cwd, ["pull", "--check"], signal)).payload;
}

/**
 * `but push` replaces the remote branch, without a lease unless the project
 * turned GitButler's force-push protection on. So right after the fetch, the
 * push stops when it would delete an upstream commit the reader did not
 * agree to, and names every commit it would delete, to be asked about.
 */
async function unacceptedLoss(
  cwd: string,
  status: unknown,
  branch: ButBranch,
  accepted: readonly string[],
  signal: AbortSignal,
): Promise<string[] | null> {
  const workspace = await compareWithRemotes(cwd, parseWorkspace(status), signal);
  const stack = workspace.stacks.find((candidate) =>
    candidate.branches.some((entry) => entry.name === branch.name),
  )?.branches;
  const pushedWith = stack?.slice(stack.findIndex((entry) => entry.name === branch.name)) ?? [];
  const agreed = new Set(accepted);
  const loss = upstreamLoss(pushedWith);
  return loss.some((commit) => !agreed.has(commit)) ? loss : null;
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
): Promise<VcsResult> {
  const check = pullCheck(await fetchRemotes(cwd, signal));
  if (check.upToDate) return UP_TO_DATE;
  // Per branch only: a branch that already holds a conflicted commit stays
  // listed, since the check cannot tell whether it gains another.
  const risk = { conflicted: check.conflicted, overlapsUncommitted: check.overlapsUncommitted };
  if (!accepts(accepted, risk)) return { status: "confirm", risk, loss: null };
  await runButAction(cwd, ["pull"], signal);
  return DONE;
}
