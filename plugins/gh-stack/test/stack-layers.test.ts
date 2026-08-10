import assert from "node:assert/strict";
import { test } from "node:test";
import { projectStackLayers } from "../lib/stack-layers.ts";

type Layer = { name: string; isMerged: boolean; marker: number };

function layer(name: string, isMerged: boolean, marker: number): Layer {
  return { name, isMerged, marker };
}

test("merged layers are hidden and a merged current layer moves to the nearest active layer above", () => {
  const bottom = layer("bottom", false, 1);
  const current = layer("current", true, 2);
  const mergedAbove = layer("merged-above", true, 3);
  const next = layer("next", false, 4);
  const top = layer("top", false, 5);

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
      layer("active-below", false, 1),
      layer("current", true, 2),
      layer("merged-top", true, 3),
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
    [layer("bottom", true, 1), layer("top", true, 2)],
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
    layer("merged", true, 1),
    layer("active", false, 2),
    layer("queued", false, 3),
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
