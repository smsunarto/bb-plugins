import { expect, test } from "bun:test";
import { positionPatch, turnChanges } from "../src/shared/patches.ts";
import type { LatestTurn } from "../src/shared/contract.ts";
const base: LatestTurn = { turnId: "t", anchorId: "m", changes: [], patch: null, limited: false };
const patch =
  "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,2 @@\n-old\n+new\n+second\n";

test("splits aggregate patches into files and counts only hunk changes", () => {
  const changes = turnChanges({ ...base, patch: patch + patch.replaceAll("a.ts", "b.ts") });
  expect(changes.map(({ path, added, removed }) => ({ path, added, removed }))).toEqual([
    { path: "a.ts", added: 2, removed: 1 },
    { path: "b.ts", added: 2, removed: 1 },
  ]);
});
test("empty patches render nothing and unparseable patches remain inspectable", () => {
  expect(turnChanges({ ...base, patch: "" })).toEqual([]);
  expect(turnChanges({ ...base, patch: "provider-specific patch" })[0]?.patch).toBe(
    "provider-specific patch",
  );
});

test("counts parsed hunk lines without treating the patch signature as a deletion", () => {
  const [change] = turnChanges({ ...base, patch: `${patch}\n-- \n2.49.0\n` });
  expect(change).toMatchObject({ path: "a.ts", added: 2, removed: 1 });
});

test("sums changes across hunks without counting context or newline markers", () => {
  const multiHunk =
    "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n" +
    "@@ -1,2 +1,2 @@\n unchanged\n-old\n+new\n" +
    "@@ -8 +8,2 @@\n-last\n+replacement\n+extra\n\\ No newline at end of file\n";
  expect(turnChanges({ ...base, patch: multiHunk })[0]).toMatchObject({
    path: "a.ts",
    added: 3,
    removed: 2,
  });
});

const hunkless =
  "--- a/x/app.css\n+++ b/x/app.css\n-  --diffs-gap-block: 4px;\n+  --diffs-gap-block: 2px;\n+  --diffs-gap-inline: 6px;\n";

test("synthesizes a hunk header for provider changes recorded without one", () => {
  expect(positionPatch(hunkless)).toEqual({
    patch: hunkless.replace("+++ b/x/app.css\n", "+++ b/x/app.css\n@@ -1,1 +1,2 @@\n"),
    synthesized: true,
  });
  expect(positionPatch(patch)).toEqual({ patch, synthesized: false });
  expect(positionPatch("--- /dev/null\n+++ b/a.txt\n+line a\n").patch).toContain("@@ -0,0 +1,1 @@");
});

test("recorded changes without hunk headers render positioned and hide line numbers", () => {
  const change = { id: "c", path: "x/app.css", patch: hunkless, added: 2, removed: 1 };
  const [positioned] = turnChanges({ ...base, changes: [change] });
  expect(positioned).toMatchObject({ unpositioned: true, added: 2, removed: 1 });
  expect(positioned?.patch).toContain("@@ -1,1 +1,2 @@");
  const [kept] = turnChanges({ ...base, changes: [{ ...change, patch }] });
  expect(kept).toEqual({ ...change, patch });
});

test("Git-quoted file names are shown as their real names", () => {
  const quoted =
    'diff --git "a/we\\"ird\\ttab.ts" "b/we\\"ird\\ttab.ts"\nnew file mode 100644\n--- /dev/null\n+++ "b/we\\"ird\\ttab.ts"\n@@ -0,0 +1 @@\n+x\n';
  const octal =
    'diff --git "a/\\303\\274.ts" "b/\\303\\274.ts"\n--- "a/\\303\\274.ts"\n+++ "b/\\303\\274.ts"\n@@ -1 +1 @@\n-a\n+b\n';
  const turn = { turnId: "t", anchorId: null, changes: [], limited: false };
  expect(turnChanges({ ...turn, patch: quoted }).map((change) => change.path)).toEqual([
    'we"ird\ttab.ts',
  ]);
  expect(turnChanges({ ...turn, patch: octal }).map((change) => change.path)).toEqual(["ü.ts"]);
});

test("quoted names keep characters outside the Basic Multilingual Plane", () => {
  const astral =
    'diff --git "a/😀\\"File\\".unity" "b/😀\\"File\\".unity"\nnew file mode 100644\n--- /dev/null\n+++ "b/😀\\"File\\".unity"\n@@ -0,0 +1 @@\n+x\n';
  const turn = { turnId: "t", anchorId: null, changes: [], limited: false };
  expect(turnChanges({ ...turn, patch: astral }).map((change) => change.path)).toEqual([
    '😀"File".unity',
  ]);
});

test("recorded edits a patch cannot cover render beside it", () => {
  const submodule = { id: "s", path: "vendor/lib/x.ts", patch, added: 1, removed: 1 };
  const changes = turnChanges({ ...base, patch, changes: [submodule] });
  expect(changes.map((change) => change.path)).toEqual(["a.ts", "vendor/lib/x.ts"]);
});
