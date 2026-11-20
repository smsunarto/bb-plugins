import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getSingularPatch } from "@pierre/diffs";
import { describe, expect, test } from "vitest";
import { readPatchFile, unquote, type PatchFile } from "./patch-file.ts";

const FIXTURES = join(import.meta.dirname, "../../test/fixtures/patch-file");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

/** Each file as path, kind, counts, and whether Pierre can draw its patch. */
function summary(read: PatchFile | null) {
  return read?.commits.map((commit) =>
    commit.files.map(({ file, patch }) => ({
      path: file.path,
      kind: file.kind,
      previousPath: file.previousPath,
      counts: `+${file.additions} -${file.deletions}`,
      binary: file.binary,
      drawn: patch.patch === "" ? null : getSingularPatch(patch.patch).name,
    })),
  );
}

describe("readPatchFile", () => {
  test("git format-patch mail with two commits: headers, renames, added, deleted, binary", () => {
    const read = readPatchFile(fixture("format-patch-two-commits.patch"));
    expect(
      read?.commits.map(({ id, subject, author, date }) => ({ id, subject, author, date })),
    ).toEqual([
      {
        id: "a97a0f96e718208d9111a63688e332a9e3d7651e",
        subject: "Rework files: rename, add, delete",
        author: "Ada Lövelace <ada@example.com>",
        date: "Fri, 2 Jan 2026 03:04:05 +0000",
      },
      {
        id: "5b6545a5d03cfb5b93c46a153f446dbf122d05ad",
        subject: "Add logo and a fourth line",
        author: "Ada Lövelace <ada@example.com>",
        date: "Fri, 2 Jan 2026 03:04:05 +0000",
      },
    ]);
    expect(summary(read)).toEqual([
      [
        {
          path: "added.ts",
          kind: "added",
          previousPath: null,
          counts: "+2 -0",
          binary: false,
          drawn: "added.ts",
        },
        {
          path: "dir with space/after.md",
          kind: "renamed",
          previousPath: "before.md",
          counts: "+0 -0",
          binary: false,
          drawn: null,
        },
        {
          path: "gone.txt",
          kind: "deleted",
          previousPath: null,
          counts: "+0 -1",
          binary: false,
          drawn: "gone.txt",
        },
        {
          path: "keep.txt",
          kind: "modified",
          previousPath: null,
          counts: "+1 -1",
          binary: false,
          drawn: "keep.txt",
        },
      ],
      [
        {
          path: "keep.txt",
          kind: "modified",
          previousPath: null,
          counts: "+1 -0",
          binary: false,
          drawn: "keep.txt",
        },
        {
          path: "logo.png",
          kind: "added",
          previousPath: null,
          counts: "+0 -0",
          binary: true,
          drawn: null,
        },
      ],
    ]);
    expect(read).toMatchObject({ files: 6, additions: 4, deletions: 2 });
  });

  test("the mail signature and diffstat stay out of every file's patch", () => {
    const read = readPatchFile(fixture("format-patch-two-commits.patch"))!;
    for (const { patch } of read.commits.flatMap((commit) => commit.files)) {
      expect(patch.patch).not.toMatch(/^-- $/m);
      expect(patch.patch).not.toMatch(/files? changed/);
    }
  });

  test("a GIT binary patch body is skipped, and the file is marked binary", () => {
    const read = readPatchFile(fixture("format-patch-git-binary.patch"));
    expect(summary(read)).toEqual([
      [
        {
          path: "keep.txt",
          kind: "modified",
          previousPath: null,
          counts: "+1 -0",
          binary: false,
          drawn: "keep.txt",
        },
        {
          path: "logo.png",
          kind: "added",
          previousPath: null,
          counts: "+0 -0",
          binary: true,
          drawn: null,
        },
      ],
    ]);
  });

  test("git diff across commits: a pure rename has no patch, but keeps both paths", () => {
    const read = readPatchFile(fixture("git-diff-renames.diff"));
    expect(read?.commits).toHaveLength(1);
    expect(read?.commits[0]).toMatchObject({ id: null, subject: null });
    expect(summary(read)![0]!.map((file) => [file.path, file.kind, file.previousPath])).toEqual([
      ["added.ts", "added", null],
      ["dir with space/after.md", "renamed", "before.md"],
      ["gone.txt", "deleted", null],
      ["keep.txt", "modified", null],
      ["logo.png", "added", null],
    ]);
  });

  test("git log -p: one section per commit, subject from the indented message", () => {
    const read = readPatchFile(fixture("git-log-p.patch"));
    expect(
      read?.commits.map((commit) => [commit.id?.slice(0, 7), commit.subject, commit.files.length]),
    ).toEqual([
      ["5b6545a", "Add logo and a fourth line", 2],
      ["a97a0f9", "Rework files: rename, add, delete", 4],
    ]);
    expect(read?.commits[0]!.author).toBe("Ada Lövelace <ada@example.com>");
  });

  test("plain diff -u output, with timestamps after the paths", () => {
    expect(summary(readPatchFile(fixture("plain-diff-u.diff")))).toEqual([
      [
        {
          path: "b.txt",
          kind: "modified",
          previousPath: null,
          counts: "+1 -1",
          binary: false,
          drawn: "b.txt",
        },
      ],
    ]);
  });

  test("hunks are walked by count: removed lines that look like headers stay inside", () => {
    const text = [
      "diff --git a/notes.md b/notes.md",
      "--- a/notes.md",
      "+++ b/notes.md",
      "@@ -1,4 +1,2 @@",
      "-- dash",
      "-diff --git a/x b/x",
      " kept",
      "",
      "\\ No newline at end of file",
      "diff --git a/next.md b/next.md",
      "--- a/next.md",
      "+++ b/next.md",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "",
    ].join("\n");
    expect(summary(readPatchFile(text))![0]!.map((file) => [file.path, file.counts])).toEqual([
      ["notes.md", "+0 -2"],
      ["next.md", "+1 -1"],
    ]);
  });

  test("a git diff without index lines (as an agent writes one) still draws", () => {
    const text = [
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1,2 +1,2 @@",
      " # Title",
      "-old",
      "+new",
      "diff --git a/scripts/probe.mjs b/scripts/probe.mjs",
      "--- a/scripts/probe.mjs",
      "+++ b/scripts/probe.mjs",
      "@@ -1 +1 @@",
      '-import a from "a";',
      '+import b from "b";',
    ].join("\n");
    expect(summary(readPatchFile(text))![0]!.map((file) => file.drawn)).toEqual([
      "README.md",
      "scripts/probe.mjs",
    ]);
  });

  test("a path twice in one commit starts a new section, as cards are keyed by path", () => {
    const file = "--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-a\n+b\n";
    const read = readPatchFile(`${file}${file}`);
    expect(read?.commits.map((commit) => commit.files.map((entry) => entry.file.path))).toEqual([
      ["x.txt"],
      ["x.txt"],
    ]);
  });

  test("a message line that reads like a commit line does not start a section", () => {
    const sha = "a97a0f96e718208d9111a63688e332a9e3d7651e";
    const text = [
      `From ${sha} Mon Sep 17 00:00:00 2001`,
      "From: Ada <ada@example.com>",
      "Subject: [PATCH] Revert the bad one",
      "",
      `commit ${sha} broke the build; this reverts it.`,
      `From ${sha} is mentioned here too.`,
      "---",
      "diff --git a/x.txt b/x.txt",
      "--- a/x.txt",
      "+++ b/x.txt",
      "@@ -1 +1 @@",
      "-a",
      "+b",
    ].join("\n");
    const read = readPatchFile(text);
    expect(read?.commits.map((commit) => [commit.subject, commit.files.length])).toEqual([
      ["Revert the bad one", 1],
    ]);
  });

  test("CRLF line endings read as LF", () => {
    const text = "--- a/x.txt\r\n+++ b/x.txt\r\n@@ -1 +1 @@\r\n-a\r\n+b\r\n";
    expect(summary(readPatchFile(text))).toEqual([
      // Pierre keeps the b/ prefix of a diff with no `diff --git` line; the card shows `path`.
      [
        {
          path: "x.txt",
          kind: "modified",
          previousPath: null,
          counts: "+1 -1",
          binary: false,
          drawn: "b/x.txt",
        },
      ],
    ]);
  });

  test("quoted git paths are unquoted, octal escapes as UTF-8", () => {
    expect(unquote('"caf\\303\\251 \\"x\\".txt"')).toBe('café "x".txt');
    const text = [
      'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"',
      "index 1..2 100644",
      "Binary files a/x and b/x differ",
    ].join("\n");
    expect(summary(readPatchFile(text))![0]![0]).toMatchObject({ path: "café.txt", binary: true });
  });

  test.each([
    ["empty text", ""],
    ["prose", "Hello.\nThis is not a patch at all.\n"],
    ["a hunk with no file", "@@ -1 +1 @@\n-a\n+b\n"],
    [
      "a format-patch header with no diff",
      "From 1234567890abcdef1234567890abcdef12345678 Mon Sep 17 00:00:00 2001\nSubject: x\n\nbody\n",
    ],
    ["binary noise", "\u0000\u0001\u0002PNG\u0000"],
  ])("malformed input (%s) reads as null, without throwing", (_, text) => {
    expect(readPatchFile(text)).toBeNull();
  });

  test("a truncated hunk keeps what it has, and Pierre can still draw it", () => {
    const text = "--- a/x.txt\n+++ b/x.txt\n@@ -1,10 +1,10 @@\n-a\n+b\n";
    const read = readPatchFile(text);
    expect(summary(read)![0]![0]).toMatchObject({ path: "x.txt", counts: "+1 -1" });
  });

  test("a 5,000-line patch reads in well under a frame budget per thousand lines", () => {
    const files = Array.from({ length: 100 }, (_, index) => {
      const body = Array.from({ length: 49 }, (_, line) =>
        line % 2 ? `+added ${line}` : `-removed ${line}`,
      );
      const adds = body.filter((line) => line.startsWith("+")).length;
      return [
        `diff --git a/src/file-${index}.ts b/src/file-${index}.ts`,
        `--- a/src/file-${index}.ts`,
        `+++ b/src/file-${index}.ts`,
        `@@ -1,${body.length - adds} +1,${adds} @@`,
        ...body,
      ].join("\n");
    });
    const text = files.join("\n");
    expect(text.split("\n").length).toBeGreaterThanOrEqual(5000);
    const started = performance.now();
    const read = readPatchFile(text);
    const took = performance.now() - started;
    expect(read?.files).toBe(100);
    expect(took).toBeLessThan(200);
  });
});
