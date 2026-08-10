import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_DIFF_FILES,
  buildChangeSet,
  parseNameStatusZ,
  parseNumstatZ,
  parsePorcelainZ,
  parseWcLines,
  type DiffEntry,
} from "../lib/git-diff.ts";

test("parseNumstatZ handles text, binary, and renamed files", () => {
  const parsed = parseNumstatZ(
    "12\t3\tsrc/a.ts\x00-\t-\timage.png\x001\t2\t\x00old name.ts\x00new name.ts\x00",
  );
  assert.deepEqual(parsed.get("src/a.ts"), { additions: 12, deletions: 3 });
  assert.deepEqual(parsed.get("image.png"), { additions: null, deletions: null });
  assert.deepEqual(parsed.get("new name.ts"), { additions: 1, deletions: 2 });
  assert.equal(parsed.has("old name.ts"), false);
});

test("parseNameStatusZ preserves rename and copy source paths", () => {
  assert.deepEqual(
    parseNameStatusZ(
      "M\0plain.ts\0R100\0old.ts\0new.ts\0C90\0source.ts\0copy.ts\0D\0gone.ts\0",
    ),
    [
      { status: "modified", path: "plain.ts", previousPath: null },
      { status: "renamed", path: "new.ts", previousPath: "old.ts" },
      { status: "added", path: "copy.ts", previousPath: "source.ts" },
      { status: "deleted", path: "gone.ts", previousPath: null },
    ],
  );
});

test("parsePorcelainZ handles staged renames and unusual filenames", () => {
  assert.deepEqual(
    parsePorcelainZ(
      "R  new name.ts\0old name.ts\0?? line\nbreak.txt\0 M tab\tname.ts\0",
    ),
    [
      { status: "renamed", path: "new name.ts", previousPath: "old name.ts" },
      { status: "untracked", path: "line\nbreak.txt", previousPath: null },
      { status: "modified", path: "tab\tname.ts", previousPath: null },
    ],
  );
});

test("buildChangeSet truncates rows without truncating aggregate totals", () => {
  const entries: DiffEntry[] = Array.from(
    { length: MAX_DIFF_FILES + 1 },
    (_, index) => ({
      status: "modified",
      path: `file-${index}.ts`,
      previousPath: null,
    }),
  );
  const counts = new Map(
    entries.map((entry) => [entry.path, { additions: 1, deletions: 2 }]),
  );
  const changeSet = buildChangeSet(entries, counts);
  assert.equal(changeSet.files.length, MAX_DIFF_FILES);
  assert.equal(changeSet.truncated, true);
  assert.equal(changeSet.additions, MAX_DIFF_FILES + 1);
  assert.equal(changeSet.deletions, (MAX_DIFF_FILES + 1) * 2);
});

test("parseWcLines ignores totals and preserves spaces", () => {
  assert.deepEqual(
    [...parseWcLines("  4 ./one file.txt\n 10 ./two.txt\n 14 total\n")],
    [
      ["one file.txt", 4],
      ["two.txt", 10],
    ],
  );
});
