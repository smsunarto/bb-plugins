import assert from "node:assert/strict";
import { test } from "node:test";
import { mergePrefix, pruneCandidates, type ActionBranch } from "../lib/stack-actions.ts";

const branch = (name: string, state = "OPEN", draft = false): ActionBranch => ({
  name,
  isMerged: state === "MERGED",
  pr: { number: Number(name.slice(1)), state, isDraft: draft },
});

test("prune candidates select only merged metadata or direct PR state", () => {
  const mergedFlagOnly = branch("b3");
  mergedFlagOnly.isMerged = true;
  assert.deepEqual(
    pruneCandidates([
      branch("b1", "MERGED"),
      branch("b2"),
      mergedFlagOnly,
      branch("b4", "CLOSED"),
    ]),
    ["b1", "b3"],
  );
});

test("merge prefix stops at a missing PR", () => {
  const missing = branch("b2");
  missing.pr = null;
  assert.deepEqual(
    mergePrefix([branch("b1"), missing, branch("b3")]).selected.map((item) => item.name),
    ["b1"],
  );
});

test("merge prefix stops at CLOSED and honors a valid pin", () => {
  const layers = [
    branch("b1"),
    branch("b2"),
    branch("b3", "CLOSED"),
    branch("b4"),
  ];
  assert.deepEqual(mergePrefix(layers).selected.map((item) => item.name), ["b1", "b2"]);
  assert.deepEqual(mergePrefix(layers, 1).selected.map((item) => item.name), ["b1"]);
});

test("a missing pin selects nothing", () => {
  const layers = [branch("b1"), branch("b2")];
  assert.equal(mergePrefix(layers, 4).pinned, false);
  assert.deepEqual(mergePrefix(layers, 4).selected, []);
});

test("QUEUED layers are eligible while drafts block the prefix", () => {
  assert.deepEqual(
    mergePrefix([branch("b1", "QUEUED"), branch("b2", "OPEN", true)]).selected.map(
      (item) => item.name,
    ),
    ["b1"],
  );
});

test("merged layers are excluded from selection", () => {
  assert.deepEqual(
    mergePrefix([branch("b1", "MERGED"), branch("b2")]).selected.map(
      (item) => item.name,
    ),
    ["b2"],
  );
  assert.equal(mergePrefix([branch("b1", "MERGED")], 1).pinned, false);
});
