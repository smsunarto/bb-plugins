/**
 * Merge all on a grouped card: each pull request in card order, one at a
 * time, through the same pinned merge as the dialog. Each is merged only at
 * the head and base the reader saw when they chose Merge all, and the run
 * stops at the first that does not merge, saying which did.
 */
import type { ForgeResult, Problem } from "../core/change.ts";
import { describeProblem } from "../core/change.ts";
import { initialMethod, mergeIssue, type MergeMethod, type MergePolicy } from "../core/merge.ts";
import type { MergeTarget } from "./merge.tsx";

type PolicyAnswer = { ok: true; policy: MergePolicy } | { ok: false; problem: Problem };

export type MergeAllDeps = {
  policy: (target: MergeTarget) => Promise<PolicyAnswer>;
  merge: (target: MergeTarget, method: MergeMethod) => Promise<ForgeResult>;
  wait: (ms: number) => Promise<void>;
  /** Called as each pull request starts. */
  onStart?: (index: number) => void;
};

export type MergeAllOutcome = {
  merged: MergeTarget[];
  stopped: { target: MergeTarget; reason: string } | null;
  /** Not tried, because an earlier one stopped the run. */
  skipped: MergeTarget[];
};

/** While GitHub is still computing the merge state, it is read again, a few times. */
const UNKNOWN_READS = 5;
const UNKNOWN_WAIT_MS = 2_000;

const problemText = (problem: Problem) =>
  "detail" in problem ? problem.detail : describeProblem(problem);

async function freshPolicy(target: MergeTarget, deps: MergeAllDeps): Promise<PolicyAnswer> {
  let answer = await deps.policy(target);
  for (let read = 1; read < UNKNOWN_READS; read++) {
    if (!answer.ok || answer.policy.mergeStateStatus !== "UNKNOWN") return answer;
    await deps.wait(UNKNOWN_WAIT_MS);
    answer = await deps.policy(target);
  }
  return answer;
}

/** Why `target` did not merge, or null when it did (or already had). */
async function mergeOne(target: MergeTarget, deps: MergeAllDeps): Promise<string | null> {
  const answer = await freshPolicy(target, deps);
  if (!answer.ok) return problemText(answer.problem);
  if (answer.policy.state === "MERGED") return null;
  const method = initialMethod(answer.policy.methods, "squash");
  const issue = mergeIssue({ policy: answer.policy, head: target.head, base: target.base, method });
  if (issue) return issue;
  const result = await deps.merge(target, method);
  if (result.status === "done" || result.status === "upToDate") return null;
  if (result.status === "conflict") return result.detail;
  return `${problemText(result.problem)} It may still have merged; refresh to check.`;
}

export async function mergeAll(
  targets: readonly MergeTarget[],
  deps: MergeAllDeps,
): Promise<MergeAllOutcome> {
  const merged: MergeTarget[] = [];
  for (const [index, target] of targets.entries()) {
    deps.onStart?.(index);
    let reason: string | null;
    try {
      reason = await mergeOne(target, deps);
    } catch (error) {
      reason = `${error instanceof Error ? error.message : "The request failed."} It may still have merged; refresh to check.`;
    }
    if (reason !== null)
      return { merged, stopped: { target, reason }, skipped: targets.slice(index + 1) };
    merged.push(target);
  }
  return { merged, stopped: null, skipped: [] };
}

const numbers = (targets: readonly MergeTarget[]) =>
  targets.map((target) => `#${target.number}`).join(", ");

/** "Merged #1, #2." / "Merged #1. Stopped at #2: …. Not tried: #3." */
export function mergeAllText(outcome: MergeAllOutcome): string {
  const parts: string[] = [];
  parts.push(outcome.merged.length > 0 ? `Merged ${numbers(outcome.merged)}.` : "Merged none.");
  if (outcome.stopped)
    parts.push(`Stopped at #${outcome.stopped.target.number}: ${outcome.stopped.reason}`);
  if (outcome.skipped.length > 0) parts.push(`Not tried: ${numbers(outcome.skipped)}.`);
  return parts.join(" ");
}
