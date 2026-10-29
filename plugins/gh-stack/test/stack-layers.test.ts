import assert from "node:assert/strict";
import { test } from "node:test";
import type { PrLifecycle } from "../lib/pr-metadata.ts";
import { hasExtendableLayers, projectStackLayers } from "../lib/stack-layers.ts";

type Layer = { name: string; pr: { lifecycle: PrLifecycle } | null; marker: number };

function layer(name: string, lifecycle: PrLifecycle | null, marker: number): Layer {
  return { name, pr: lifecycle === null ? null : { lifecycle }, marker };
}

test("merged layers are hidden and a merged current layer moves to the nearest active layer above", () => {
  const bottom = layer("bottom", "open", 1);
  const current = layer("current", "merged", 2);
  const mergedAbove = layer("merged-above", "merged", 3);
  const next = layer("next", "draft", 4);
  const top = layer("top", null, 5);

  const projected = projectStackLayers(
    [bottom, current, mergedAbove, next, top],
    "main",
    "current",
  );

  assert.deepEqual(projected.visibleBranches, [bottom, next, top]);
  assert.deepEqual(projected.checkout, {
    mergedBranch: "current",
    target: { kind: "branch", name: "next" },
  });
});

test("a merged current layer moves to the stack trunk when no active layer remains above", () => {
  const projected = projectStackLayers(
    [
      layer("active-below", "open", 1),
      layer("current", "merged", 2),
      layer("merged-top", "merged", 3),
    ],
    "develop",
    "current",
  );

  assert.deepEqual(
    projected.visibleBranches.map((branch) => branch.name),
    ["active-below"],
  );
  assert.deepEqual(projected.checkout, {
    mergedBranch: "current",
    target: { kind: "trunk", name: "develop" },
  });
});

test("all merged layers disappear and the current layer moves to the trunk", () => {
  const projected = projectStackLayers(
    [layer("bottom", "merged", 1), layer("top", "merged", 2)],
    "main",
    "top",
  );

  assert.deepEqual(projected.visibleBranches, []);
  assert.deepEqual(projected.checkout, {
    mergedBranch: "top",
    target: { kind: "trunk", name: "main" },
  });
});

test("hiding other merged layers does not move an active or unknown current branch", () => {
  const branches = [
    layer("merged", "merged", 1),
    layer("active", "open", 2),
    layer("queued", "queued", 3),
  ];

  const active = projectStackLayers(branches, "main", "active");
  assert.deepEqual(
    active.visibleBranches.map((branch) => branch.name),
    ["active", "queued"],
  );
  assert.equal(active.checkout, null);

  assert.equal(projectStackLayers(branches, "main", null).checkout, null);
  assert.equal(projectStackLayers(branches, "main", "other").checkout, null);
});

test("a stack is extendable only while some layer is unmerged", () => {
  const merged = { isMerged: true, pr: { state: "MERGED" as const } };
  const open = { isMerged: false, pr: { state: "OPEN" as const } };

  assert.equal(hasExtendableLayers([merged, open]), true);
  assert.equal(hasExtendableLayers([merged, merged]), false);
  assert.equal(hasExtendableLayers([]), false);
});

test("a layer whose PR merged behind gh-stack's back is not extendable", () => {
  // gh stack view can report isMerged: false while the PR already says MERGED.
  assert.equal(hasExtendableLayers([{ isMerged: false, pr: { state: "MERGED" as const } }]), false);
  // A layer with no PR yet is still somewhere to stack onto.
  assert.equal(hasExtendableLayers([{ isMerged: false, pr: null }]), true);
  assert.equal(hasExtendableLayers([{ isMerged: false }]), true);
});
