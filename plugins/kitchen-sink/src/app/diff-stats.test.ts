import { expect, test } from "bun:test";

import { countPatchChanges } from "./diff-stats.ts";

test("counts changes across hunks and ignores file headers and context", () => {
  expect(
    countPatchChanges(
      [
        "diff --git a/demo.ts b/demo.ts",
        "--- a/demo.ts",
        "+++ b/demo.ts",
        "@@ -1,2 +1,3 @@",
        " same",
        "-old",
        "+new",
        "+extra",
        "@@ -9 +10 @@",
        "-before",
        "+after",
        "",
      ].join("\n"),
    ),
  ).toEqual({ additions: 3, deletions: 2 });
});

test("counts hunk content that looks like a file header", () => {
  expect(countPatchChanges("@@ -1 +1 @@\n---old\n+++new\n")).toEqual({
    additions: 1,
    deletions: 1,
  });
});

test("handles new files, removed files, CRLF, and missing newline markers", () => {
  expect(countPatchChanges("@@ -0,0 +1,2 @@\r\n+one\r\n+two\r\n")).toEqual({
    additions: 2,
    deletions: 0,
  });
  expect(countPatchChanges("@@ -1 +0,0 @@\n-old\n\\ No newline at end of file\n")).toEqual({
    additions: 0,
    deletions: 1,
  });
  expect(
    countPatchChanges(
      "@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n",
    ),
  ).toEqual({
    additions: 1,
    deletions: 1,
  });
});

test("does not invent counts for incomplete, malformed, or non-text patches", () => {
  for (const patch of [
    "",
    "Binary files differ",
    "rename from old\nrename to new\n",
    "@@ -1 +1 @@\n-old\n",
    "@@ -1 +1 @@\n+new\n+extra\n",
    "@@ -1 +1 @@\nnot a hunk line\n",
    "@@ -1 +1 @@\n@@ -2 +2 @@\n-a\n+b\n",
  ])
    expect(countPatchChanges(patch)).toBeNull();
});
