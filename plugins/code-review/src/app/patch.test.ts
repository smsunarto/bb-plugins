import { expect, test } from "bun:test";
import type { ChangedFile, Finding, ReviewThread } from "../shared/schema.ts";
import {
  commentTarget,
  diffLines,
  drawnRows,
  fileAnchorId,
  gitPatch,
  githubFileUrl,
  isCommentable,
  parseFilePatch,
  placeFindings,
  placeThreads,
} from "./patch.ts";

// Two hunks, as GitHub's REST API returns them: no file header, no final newline.
const HUNKS = [
  "@@ -1,4 +1,5 @@",
  " import a",
  "-const b = 1;",
  "+const b = 2;",
  "+const c = 3;",
  " ",
  " export {};",
  "@@ -20,3 +21,3 @@ function tail() {",
  " one",
  "-two",
  "+TWO",
  " three",
].join("\n");

function file(overrides: Partial<ChangedFile> = {}): ChangedFile {
  return {
    path: "src/app.ts",
    previousPath: null,
    status: "modified",
    additions: 3,
    deletions: 2,
    patch: HUNKS,
    viewed: "unviewed",
    generated: false,
    ...overrides,
  };
}

function thread(overrides: Partial<ReviewThread>): ReviewThread {
  return {
    id: "T",
    path: "src/app.ts",
    line: 2,
    startLine: null,
    startSide: null,
    side: "RIGHT",
    originalLine: 2,
    isResolved: false,
    isOutdated: false,
    isFileLevel: false,
    diffHunk: "",
    comments: [],
    ...overrides,
  };
}

function finding(overrides: Partial<Finding>): Finding {
  return {
    id: "f1",
    priority: 1,
    title: "Off by one",
    body: "",
    path: "src/app.ts",
    line: 2,
    startLine: null,
    side: "RIGHT",
    ...overrides,
  };
}

const lines = diffLines(parseFilePatch(file())!);

test("a modified file's hunks get the git header Pierre reads names from", () => {
  expect(gitPatch(file({ patch: "@@ -1 +1 @@\n-a\n+b" }))).toBe(
    "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-a\n+b\n",
  );
});

test("an added file is diffed against /dev/null", () => {
  expect(gitPatch(file({ status: "added", patch: "@@ -0,0 +1 @@\n+a" }))).toBe(
    "diff --git a/src/app.ts b/src/app.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/app.ts\n@@ -0,0 +1 @@\n+a\n",
  );
});

test("a removed file is diffed into /dev/null", () => {
  expect(gitPatch(file({ status: "removed", patch: "@@ -1 +0,0 @@\n-a\n" }))).toBe(
    "diff --git a/src/app.ts b/src/app.ts\ndeleted file mode 100644\n--- a/src/app.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n",
  );
});

test("a renamed file names its old path on the base side", () => {
  expect(
    gitPatch(file({ status: "renamed", previousPath: "src/old.ts", patch: "@@ -1 +1 @@\n-a\n+b" })),
  ).toBe(
    "diff --git a/src/old.ts b/src/app.ts\nsimilarity index 50%\nrename from src/old.ts\nrename to src/app.ts\n--- a/src/old.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-a\n+b\n",
  );
});

test("a file GitHub sent no hunks for has nothing to draw", () => {
  expect(gitPatch(file({ patch: null }))).toBeNull();
  expect(parseFilePatch(file({ patch: null }))).toBeNull();
  expect(parseFilePatch(file({ patch: "" }))).toBeNull();
});

test("Pierre reads the header's names and kind from the written patch", () => {
  const added = parseFilePatch(file({ status: "added", patch: "@@ -0,0 +1,2 @@\n+a\n+b" }))!;
  expect([added.name, added.type, added.additionLines]).toEqual([
    "src/app.ts",
    "new",
    ["a\n", "b\n"],
  ]);
  const renamed = parseFilePatch(file({ status: "renamed", previousPath: "src/old.ts" }))!;
  expect([renamed.name, renamed.prevName, renamed.type]).toEqual([
    "src/app.ts",
    "src/old.ts",
    "rename-changed",
  ]);
});

test("a two-hunk patch draws its hunk lines and one separator, not the folded lines between", () => {
  const parsed = parseFilePatch(file())!;
  // Hunk one is 6 unified rows (5 split), hunk two 4 (3 split), and the 15
  // unchanged lines before hunk two fold into one separator.
  expect(drawnRows(parsed, "unified")).toEqual({ lines: 10, separators: 1 });
  expect(drawnRows(parsed, "split")).toEqual({ lines: 8, separators: 1 });
});

test("a hunk that starts below line 1 has a separator above it", () => {
  const parsed = parseFilePatch(file({ patch: "@@ -10,2 +10,2 @@\n a\n-b\n+c" }))!;
  expect(drawnRows(parsed, "unified")).toEqual({ lines: 3, separators: 1 });
});

test("only lines inside a hunk take a comment, on the side they exist on", () => {
  // Hunk one: base 1-4, head 1-5. Base line 2 was deleted, head lines 2-3 added.
  expect(isCommentable(lines, "LEFT", 2)).toBe(true);
  expect(isCommentable(lines, "RIGHT", 3)).toBe(true);
  // Context lines exist on both sides.
  expect(isCommentable(lines, "LEFT", 4)).toBe(true);
  expect(isCommentable(lines, "RIGHT", 5)).toBe(true);
  // Between the hunks: head line 10 is not in the patch.
  expect(isCommentable(lines, "RIGHT", 10)).toBe(false);
  // The base has four lines in hunk one, so base line 5 is not in it.
  expect(isCommentable(lines, "LEFT", 5)).toBe(false);
  // Hunk two: head 21-23.
  expect(isCommentable(lines, "RIGHT", 22)).toBe(true);
  expect(isCommentable(lines, "RIGHT", 24)).toBe(false);
});

test("a gutter click on one added line comments on that line", () => {
  expect(commentTarget(lines, { start: 3, end: 3, side: "additions" })).toEqual({
    line: 3,
    side: "RIGHT",
    startLine: null,
    startSide: null,
  });
});

test("a click on a deleted line comments on the base side", () => {
  expect(commentTarget(lines, { start: 2, end: 2, side: "deletions" })).toEqual({
    line: 2,
    side: "LEFT",
    startLine: null,
    startSide: null,
  });
});

test("a range dragged upward is put top to bottom", () => {
  expect(commentTarget(lines, { start: 5, end: 2, side: "additions" })).toEqual({
    line: 5,
    side: "RIGHT",
    startLine: 2,
    startSide: "RIGHT",
  });
});

test("a range from a deleted line to an added one keeps both sides", () => {
  expect(
    commentTarget(lines, { start: 2, end: 3, side: "deletions", endSide: "additions" }),
  ).toEqual({ line: 3, side: "RIGHT", startLine: 2, startSide: "LEFT" });
});

test("a range across hunks comments on its last line alone", () => {
  expect(commentTarget(lines, { start: 1, end: 22, side: "additions" })).toEqual({
    line: 22,
    side: "RIGHT",
    startLine: null,
    startSide: null,
  });
});

test("a line outside every hunk takes no comment", () => {
  expect(commentTarget(lines, { start: 10, end: 10, side: "additions" })).toBeNull();
});

test("current threads become annotations on their side, others are listed apart", () => {
  const onAdded = thread({ id: "added", line: 3, side: "RIGHT" });
  const onDeleted = thread({ id: "deleted", line: 2, side: "LEFT" });
  const outdated = thread({ id: "outdated", line: null, isOutdated: true });
  const offDiff = thread({ id: "off", line: 10 });
  const fileLevel = thread({ id: "file", line: null, isFileLevel: true });
  const placed = placeThreads([onAdded, outdated, onDeleted, offDiff, fileLevel], lines);
  expect(
    placed.annotations.map((a) => [
      a.side,
      a.lineNumber,
      a.metadata.kind === "thread" && a.metadata.thread.id,
    ]),
  ).toEqual([
    ["additions", 3, "added"],
    ["deletions", 2, "deleted"],
  ]);
  expect(placed.outdated.map((t) => t.id)).toEqual(["outdated", "off"]);
  expect(placed.fileLevel.map((t) => t.id)).toEqual(["file"]);
});

test("findings on diff lines are inline, the rest are listed under the header", () => {
  const placed = placeFindings(
    [
      finding({ id: "f1", line: 22 }),
      finding({ id: "f2", line: 40 }),
      finding({ id: "f3", line: 2, side: "LEFT" }),
    ],
    lines,
  );
  expect(
    placed.annotations.map((a) => [
      a.side,
      a.lineNumber,
      a.metadata.kind === "finding" && a.metadata.finding.id,
    ]),
  ).toEqual([
    ["additions", 22, "f1"],
    ["deletions", 2, "f3"],
  ]);
  expect(placed.elsewhere.map((f) => f.id)).toEqual(["f2"]);
});

test("a file's anchor id is unique per path and has no spaces", () => {
  expect(fileAnchorId("docs/read me.md")).toBe("cr-file-docs%2Fread%20me.md");
  expect(fileAnchorId("a/b")).not.toBe(fileAnchorId("a_b"));
});

test("GitHub's file link anchors on the path's SHA-256", async () => {
  expect(await githubFileUrl("https://github.com/o/r/pull/7", "src/app.ts")).toBe(
    "https://github.com/o/r/pull/7/files#diff-841254fe75488c1bd4cd7f68f00b4be0e48dcfbc4a16b45847b68295e0e3b27b",
  );
});
