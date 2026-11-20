import { expect, test } from "vitest";
import type { PatchFileEntry } from "./patch-file.ts";
import { checkDrawn, CLAIM, isMailTrailer, type DrawnFile } from "./patch-guard.ts";

const H = CLAIM.header;
const B = CLAIM.hunk;
const lines = ["--- a/f.txt", "+++ b/f.txt", "@@ -1 +1 @@", "-a", "+b"];

function entry(patch: string, additions = 1, deletions = 1): PatchFileEntry {
  const file = { path: "f.txt", kind: "modified" as const, previousPath: null };
  return {
    key: "1:f.txt",
    file: { ...file, additions, deletions, binary: false },
    patch: { ...file, patch, truncated: false },
  };
}

const whole = (patch = `${lines.join("\n")}\n`): DrawnFile[] => [
  { start: 0, end: 5, body: 2, entry: entry(patch) },
];

test("a faithful read passes", () => {
  expect(checkDrawn(lines, Uint8Array.of(H, H, H, B, B), [], whole())).toBeNull();
});

test("a hunk-looking line nobody claimed fails the read, a boundary lookalike included", () => {
  const more = [...lines, "--flag"];
  expect(checkDrawn(more, Uint8Array.of(H, H, H, B, B, 0), [], whole())).toBe(
    "Line 6 reads as a hunk line, but no file's hunk holds it.",
  );
  // Declared by the mail, the boundary ends the patch.
  expect(
    checkDrawn(
      ["From x", ...more],
      Uint8Array.of(0, H, H, H, B, B, 0),
      [{ start: 0, boundary: "flag" }],
      [{ start: 1, end: 6, body: 2, entry: entry(`${lines.join("\n")}\n`) }],
    ),
  ).toBeNull();
});

test("a card whose patch lost or gained a line fails the read", () => {
  const claims = Uint8Array.of(H, H, H, B, B);
  expect(checkDrawn(lines, claims, [], whole("--- a/f.txt\n+++ b/f.txt\n@@ -1 +1 @@\n-a\n"))).toBe(
    "The diff view's copy of f.txt doesn't match its lines in this file.",
  );
  expect(checkDrawn(lines, claims, [], [{ ...whole()[0]!, body: 1 }])).toBe(
    "The diff view's copy of f.txt doesn't match its lines in this file.",
  );
  // Claimed hunk lines that no file accounts for.
  expect(checkDrawn([...lines, "+c"], Uint8Array.of(H, H, H, B, B, B), [], whole())).toBe(
    "The diff view's copy doesn't hold every hunk line of this file.",
  );
});

test("a trimmed signature counts only before git's version line", () => {
  expect(isMailTrailer("--", "2.43.0", null)).toBe(true);
  expect(isMailTrailer("--", "+b", null)).toBe(false);
  expect(isMailTrailer("--flag", undefined, null)).toBe(false);
  expect(isMailTrailer("--b1--", undefined, "b1")).toBe(true);
});
