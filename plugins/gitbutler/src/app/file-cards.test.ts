import { expect, test } from "bun:test";
import { parsePatch } from "./file-cards.tsx";

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
