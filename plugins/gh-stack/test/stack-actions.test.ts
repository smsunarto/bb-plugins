import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mergePrefix,
  pruneCandidates,
  stackMergeArgs,
  stackMergeWasQueued,
  type ActionBranch,
} from "../lib/stack-actions.ts";

const branch = (
  name: string,
  lifecycle: NonNullable<ActionBranch["pr"]>["lifecycle"] = "open",
): ActionBranch => ({
  name,
  pr: { number: Number(name.slice(1)), lifecycle },
});

test("prune candidates are exactly the merged layers", () => {
  assert.deepEqual(
    pruneCandidates([
      branch("b1", "merged"),
      branch("b2"),
      branch("b3", "merged"),
      branch("b4", "closed"),
      { name: "b5", pr: null },
    ]),
    ["b1", "b3"],
  );
});

test("stack merge arguments pin the PR, confirmation, and method", () => {
  assert.deepEqual(stackMergeArgs(42, "squash"), [
    "stack",
    "merge",
    "42",
    "--yes",
    "--merge-method",
    "squash",
  ]);
  assert.equal(stackMergeArgs(7, "rebase").at(-1), "rebase");
  assert.equal(stackMergeArgs(9, "merge").at(-1), "merge");
});

test("stack merge queue output is distinguished from a completed merge", () => {
  assert.equal(stackMergeWasQueued("Added to the merge queue", ""), true);
  assert.equal(stackMergeWasQueued("", "PR #42 is queued for merge"), true);
  assert.equal(stackMergeWasQueued("Merged feature into main", ""), false);
});

test("merge prefix stops at a missing PR", () => {
  const missing = branch("b2");
  missing.pr = null;
  assert.deepEqual(
    mergePrefix([branch("b1"), missing, branch("b3")]).selected.map((item) => item.name),
    ["b1"],
  );
});

test("merge prefix stops at a closed PR and honors a valid pin", () => {
  const layers = [branch("b1"), branch("b2"), branch("b3", "closed"), branch("b4")];
  assert.deepEqual(
    mergePrefix(layers).selected.map((item) => item.name),
    ["b1", "b2"],
  );
  assert.deepEqual(
    mergePrefix(layers, 1).selected.map((item) => item.name),
    ["b1"],
  );
});

test("a missing pin selects nothing", () => {
  const layers = [branch("b1"), branch("b2")];
  assert.equal(mergePrefix(layers, 4).pinned, false);
  assert.deepEqual(mergePrefix(layers, 4).selected, []);
});

test("queued layers are eligible while drafts block the prefix", () => {
  assert.deepEqual(
    mergePrefix([branch("b1", "queued"), branch("b2", "draft")]).selected.map((item) => item.name),
    ["b1"],
  );
});

// Unknown covers a PR GitHub could not read and a state gh-stack named that
// this build does not; both block without counting as merged.
test("an unknown lifecycle blocks the prefix without counting as merged", () => {
  const prefix = mergePrefix([branch("b1", "unknown"), branch("b2")]);
  assert.deepEqual(prefix.selected, []);
  assert.equal(prefix.blocker?.name, "b1");
});

test("merged layers are excluded from selection", () => {
  assert.deepEqual(
    mergePrefix([branch("b1", "merged"), branch("b2")]).selected.map((item) => item.name),
    ["b2"],
  );
  assert.equal(mergePrefix([branch("b1", "merged")], 1).pinned, false);
});
