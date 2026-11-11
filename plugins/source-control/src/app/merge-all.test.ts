import { expect, test } from "vitest";
import type { ForgeResult } from "../core/change.ts";
import { changeKeySchema } from "../core/ids.ts";
import type { MergePolicy } from "../core/merge.ts";
import { mergeAll, mergeAllText } from "./merge-all.ts";
import type { MergeTarget } from "./merge.tsx";

const target = (number: number): MergeTarget => ({
  changeKey: changeKeySchema.parse(`gh:acme/api:scott:b${number}`),
  repo: "acme/api",
  number,
  title: `PR ${number}`,
  head: `${number}`.repeat(40).slice(0, 40),
  base: "main",
});

const policy = (t: MergeTarget, change: Partial<MergePolicy> = {}): MergePolicy => ({
  state: "OPEN",
  isDraft: false,
  headRefOid: t.head,
  baseRefName: t.base,
  mergeStateStatus: "CLEAN",
  canMerge: true,
  methods: ["squash", "merge"],
  ...change,
});

function deps(
  answers: Record<number, Partial<MergePolicy>[]>,
  results: Record<number, ForgeResult> = {},
) {
  const merges: { number: number; method: string; head: string }[] = [];
  const reads: number[] = [];
  return {
    merges,
    reads,
    value: {
      policy: async (t: MergeTarget) => {
        reads.push(t.number);
        const queue = answers[t.number] ?? [{}];
        return {
          ok: true as const,
          policy: policy(t, queue.length > 1 ? queue.shift() : queue[0]),
        };
      },
      merge: async (t: MergeTarget, method: "merge" | "squash" | "rebase") => {
        merges.push({ number: t.number, method, head: t.head });
        return results[t.number] ?? { status: "done" as const };
      },
      wait: async () => undefined,
    },
  };
}

test("Merge all merges each pull request in order, pinned to the head shown", async () => {
  const run = deps({});
  const outcome = await mergeAll([target(1), target(2)], run.value);
  expect(run.merges).toEqual([
    { number: 1, method: "squash", head: target(1).head },
    { number: 2, method: "squash", head: target(2).head },
  ]);
  expect(mergeAllText(outcome)).toBe("Merged #1, #2.");
});

test("Merge all stops at the first that does not merge and says which merged", async () => {
  const run = deps({ 2: [{ headRefOid: "f".repeat(40) }] });
  const outcome = await mergeAll([target(1), target(2), target(3)], run.value);
  expect(run.merges.map((m) => m.number)).toEqual([1]);
  expect(mergeAllText(outcome)).toBe(
    "Merged #1. Stopped at #2: The branch changed. Review the latest commit before merging. Not tried: #3.",
  );
});

test("a refused or lost merge stops the run; an already merged one counts as merged", async () => {
  const run = deps(
    { 1: [{ state: "MERGED" }] },
    {
      2: {
        status: "failed",
        problem: { kind: "auth", site: "github.com", detail: "Token expired." },
      },
    },
  );
  const outcome = await mergeAll([target(1), target(2), target(3)], run.value);
  expect(run.merges.map((m) => m.number)).toEqual([2]);
  expect(outcome.merged.map((t) => t.number)).toEqual([1]);
  expect(outcome.stopped?.reason).toContain("It may still have merged");
  expect(outcome.skipped.map((t) => t.number)).toEqual([3]);
});

test("while GitHub is still computing the merge state, the policy is read again", async () => {
  const run = deps({ 1: [{ mergeStateStatus: "UNKNOWN" }, { mergeStateStatus: "UNKNOWN" }, {}] });
  const outcome = await mergeAll([target(1)], run.value);
  expect(run.reads).toEqual([1, 1, 1]);
  expect(outcome.stopped).toBeNull();
});
