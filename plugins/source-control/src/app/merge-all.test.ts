import { expect, test } from "vitest";
import type { ForgeResult } from "../core/change.ts";
import { changeKeySchema } from "../core/ids.ts";
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

function deps(results: Record<number, ForgeResult> = {}) {
  const merges: { number: number; method: string; head: string }[] = [];
  return {
    merges,
    value: {
      merge: async (t: MergeTarget, method: "merge" | "squash" | "rebase") => {
        merges.push({ number: t.number, method, head: t.head });
        return results[t.number] ?? { status: "done" as const };
      },
    },
  };
}

test("Merge all merges each pull request in order, pinned to the head shown", async () => {
  const run = deps();
  const outcome = await mergeAll([target(1), target(2)], run.value);
  expect(run.merges).toEqual([
    { number: 1, method: "squash", head: target(1).head },
    { number: 2, method: "squash", head: target(2).head },
  ]);
  expect(mergeAllText(outcome)).toBe("Merged #1, #2.");
});

test("Merge all stops at the first that does not merge and says which merged", async () => {
  const run = deps({ 2: { status: "conflict", detail: "#2 moved to fffffff since you looked." } });
  const outcome = await mergeAll([target(1), target(2), target(3)], run.value);
  expect(run.merges.map((m) => m.number)).toEqual([1, 2]);
  expect(mergeAllText(outcome)).toBe(
    "Merged #1. Stopped at #2: #2 moved to fffffff since you looked. Not tried: #3.",
  );
});

test("a refused or lost merge stops the run; an already merged one counts as merged", async () => {
  const run = deps({
    1: { status: "upToDate" },
    2: {
      status: "failed",
      problem: { kind: "auth", site: "github.com", detail: "Token expired." },
    },
  });
  const outcome = await mergeAll([target(1), target(2), target(3)], run.value);
  expect(run.merges.map((m) => m.number)).toEqual([1, 2]);
  expect(outcome.merged.map((t) => t.number)).toEqual([1]);
  expect(outcome.stopped?.reason).toContain("It may still have merged");
  expect(outcome.skipped.map((t) => t.number)).toEqual([3]);
});
