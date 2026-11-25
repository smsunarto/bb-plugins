import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test } from "vitest";
import { readPatchFile } from "../core/patch-file.ts";
import { parsePatch } from "./file-cards.tsx";

const FIXTURES = join(import.meta.dirname, "../../test/fixtures/patch-file");
const files = readdirSync(FIXTURES, { recursive: true, encoding: "utf8" })
  .filter((name) => /\.(?:patch|diff)$/.test(name))
  .map((name) => join(FIXTURES, name));
const HUNK = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

/** Old- and new-side line counts as the fixture's own hunk headers state them. */
function stated(patch: string): { old: number; next: number } {
  let old = 0;
  let next = 0;
  for (const line of patch.split("\n")) {
    const header = HUNK.exec(line);
    if (!header) continue;
    old += header[1] === undefined ? 1 : Number(header[1]);
    next += header[2] === undefined ? 1 : Number(header[2]);
  }
  return { old, next };
}

test.each(files.map((path) => [relative(FIXTURES, path), path]))(
  "%s: every drawn diff holds the lines its hunk headers count",
  (_, path) => {
    const read = readPatchFile(readFileSync(path, "utf8"));
    if (!read.ok) return;
    for (const commit of read.read.commits)
      for (const { file, patch } of commit.files) {
        if (patch.patch === "") continue;
        const drawn = parsePatch(patch.patch);
        expect(drawn, file.path).not.toBeNull();
        expect(
          { old: drawn!.deletionLines.length, next: drawn!.additionLines.length },
          file.path,
        ).toEqual(stated(patch.patch));
      }
  },
);

test("a blank line standing for context draws as an empty context line", () => {
  const read = readPatchFile(
    readFileSync(join(FIXTURES, "review2/gnu-suppress-blank-empty.diff"), "utf8"),
  );
  if (!read.ok) throw new Error(read.reason);
  const drawn = parsePatch(read.read.commits[0]!.files[0]!.patch.patch)!;
  expect(drawn.deletionLines).toEqual(["one\n", "\n", "two\n", "three\n", "\n", "five\n"]);
  expect(drawn.additionLines).toEqual(["one\n", "\n", "TWO\n", "three\n", "\n", "five\n"]);
});

test.each(["arbitrary-marker", "No newline at end of file"])(
  "the review mutation's %s marks the final old line only",
  (marker) => {
    const read = readPatchFile(
      `--- a/oracle.txt\n+++ b/oracle.txt\n@@ -1,2 +1,2 @@\n ctx-oracle\n-old-oracle\n\\ ${marker}\n+new-oracle\n`,
    );
    if (!read.ok) throw new Error(read.reason);
    const drawn = parsePatch(read.read.commits[0]!.files[0]!.patch.patch)!;
    expect(drawn.deletionLines).toEqual(["ctx-oracle\n", "old-oracle"]);
    expect(drawn.additionLines).toEqual(["ctx-oracle\n", "new-oracle\n"]);
    expect(drawn.hunks[0]).toMatchObject({ noEOFCRDeletions: true, noEOFCRAdditions: false });
  },
);

test.each([
  ["@@ -1,2 +1,2 @@\n-old\n\\ arbitrary-marker\n+new\n rest\n", "before the last line on its side"],
  [
    "@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n@@ -4 +4 @@\n-more\n+later\n",
    "past a no-newline marker on the same side",
  ],
])("a no-newline marker before more lines on its side falls back to text", (hunks, reason) => {
  expect(readPatchFile(`--- old\n+++ new\n${hunks}`)).toEqual({
    ok: false,
    reason: expect.stringContaining(reason),
  });
});
