import { expect, test } from "bun:test";
import { filePreview, firstChangedLine, parsePatch } from "./file-cards.tsx";

const patch = (value: number) =>
  [
    "diff --git a/src/n.ts b/src/n.ts",
    "--- a/src/n.ts",
    "+++ b/src/n.ts",
    "@@ -1 +1 @@",
    "-export const n = 0;",
    `+export const n = ${value};`,
    "",
  ].join("\n");

test("the same path with different contents gets its own highlight cache key", () => {
  const first = parsePatch(patch(111))?.cacheKey;
  const second = parsePatch(patch(999))?.cacheKey;
  expect(first).toBeString();
  expect(second).toBeString();
  expect(second).not.toBe(first);
});

test("patches whose hashes collide still get their own highlight cache keys", () => {
  // These two once shared a 32-bit FNV key, and the second drew the first's code.
  expect(parsePatch(patch(4495818603))?.cacheKey).not.toBe(parsePatch(patch(3747137693))?.cacheKey);
});

test("identical patch text shares one highlight cache key", () => {
  expect(parsePatch(patch(111))?.cacheKey).toBe(parsePatch(patch(111))?.cacheKey);
});

const hunk = (header: string, lines: readonly string[]) =>
  [
    "diff --git a/src/n.ts b/src/n.ts",
    "--- a/src/n.ts",
    "+++ b/src/n.ts",
    header,
    ...lines,
    "",
  ].join("\n");

test("a file opens on its first changed line, past the hunk's leading context", () => {
  const parsed = parsePatch(hunk("@@ -10,6 +10,7 @@", [" a", " b", " c", "+d", " e", " f", " g"]));
  expect(firstChangedLine(parsed)).toBe(13);
});

test("a removal opens on the line that now stands where it was", () => {
  const parsed = parsePatch(hunk("@@ -4,4 +4,3 @@", [" a", "-b", " c", " d"]));
  expect(firstChangedLine(parsed)).toBe(5);
});

test("a file with no patch text opens at the top", () => {
  expect(firstChangedLine(parsePatch(""))).toBeNull();
});

test("a root repository's file is named by its own path", () => {
  const open = filePreview({ environmentId: "env_1", repositoryKey: "." });
  expect(open?.("plugins/x.ts", 12)).toEqual({
    target: { kind: "workspace", environmentId: "env_1", path: "plugins/x.ts" },
    location: { kind: "line", line: 12, column: null },
  });
});

test("a child repository's file is named from the environment root", () => {
  const open = filePreview({ environmentId: "env_1", repositoryKey: "repos/app" });
  expect(open?.("src/a.ts", null)).toEqual({
    target: { kind: "workspace", environmentId: "env_1", path: "repos/app/src/a.ts" },
    location: null,
  });
});

test("nothing opens before the panel knows the environment and repository", () => {
  expect(filePreview({ environmentId: null, repositoryKey: null })).toBeNull();
  expect(filePreview({ environmentId: "env_1", repositoryKey: null })).toBeNull();
  expect(filePreview(undefined)).toBeNull();
});
