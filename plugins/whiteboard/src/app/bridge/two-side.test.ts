import { describe, expect, it } from "vitest";
import { contextPatch, lensFiles, orderDiffFiles, resolveSide, sourcePatch } from "./two-side.ts";

describe("resolveSide", () => {
  it("reads a renamed file's base at its previous path and its head at the new one", () => {
    const file = { path: "src/new.ts", previousPath: "src/old.ts", status: "renamed" };

    expect(resolveSide({ ...file, side: "base" })).toEqual({ path: "src/old.ts", side: "base" });
    expect(resolveSide({ ...file, side: "head" })).toEqual({ path: "src/new.ts", side: "head" });
  });

  it("has no base for an added file and no head for a deleted one", () => {
    expect(resolveSide({ path: "a.ts", status: "added", side: "base" })).toBeNull();
    expect(resolveSide({ path: "a.ts", status: "added", side: "head" })).toEqual({
      path: "a.ts",
      side: "head",
    });
    expect(resolveSide({ path: "a.ts", status: "deleted", side: "head" })).toBeNull();
    expect(resolveSide({ path: "a.ts", status: "deleted", side: "base" })).toEqual({
      path: "a.ts",
      side: "base",
    });
  });

  it("reads both sides of a modified file at its path", () => {
    expect(resolveSide({ path: "a.ts", status: "modified", side: "base" })).toEqual({
      path: "a.ts",
      side: "base",
    });
  });
});

describe("lensFiles and orderDiffFiles", () => {
  const files = [
    { path: "z.ts", status: "modified" as const, additions: 1, deletions: 0 },
    {
      path: "src/b.ts",
      previousPath: "src/a.ts",
      status: "renamed" as const,
      additions: 0,
      deletions: 0,
    },
    { path: "src/lib/c.ts", status: "added" as const, additions: 2, deletions: 0 },
  ];

  it("adds referenced files outside the comparison as unchanged context, once", () => {
    const lens = {
      id: "l",
      title: "L",
      reviewId: "r",
      version: 1,
      ranges: [
        { file: "src/a.ts", side: "base" as const, fromLine: 1, toLine: 2 },
        { file: "docs/x.md", side: "head" as const, fromLine: 1, toLine: 1 },
        { file: "docs/x.md", side: "head" as const, fromLine: 4, toLine: 5 },
      ],
    };

    expect(lensFiles(files, lens).map((file) => [file.path, file.status])).toEqual([
      ["z.ts", "modified"],
      ["src/b.ts", "renamed"],
      ["src/lib/c.ts", "added"],
      ["docs/x.md", "unchanged"],
    ]);
    expect(lensFiles(files, { ...lens, wholeFiles: true })).toBe(files);
  });

  it("orders folders first, then files by name, like the tree", () => {
    expect(orderDiffFiles(files).map((file) => file.path)).toEqual([
      "src/lib/c.ts",
      "src/b.ts",
      "z.ts",
    ]);
  });
});

describe("sourcePatch", () => {
  const file = { path: "src/a.ts", status: "modified" as const, additions: 2, deletions: 2 };
  const base = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
  const head = [...base];
  head[4] = "changed 5";
  head[24] = "changed 25";
  const text = (lines: string[]) => `${lines.join("\n")}\n`;

  it("keeps true line numbers and only the peek's intersecting hunks", () => {
    expect(
      sourcePatch({
        file,
        base: text(base),
        head: text(head),
        ranges: [{ file: file.path, side: "head", fromLine: 25, toLine: 25 }],
      }),
    ).toEqual({
      text: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -22,7 +22,7 @@\n line 22\n line 23\n line 24\n-line 25\n+changed 25\n line 26\n line 27\n line 28\n",
      firstChangedLine: 25,
    });
  });
  it("names the first changed head line of the whole file", () => {
    expect(sourcePatch({ file, base: text(base), head: text(head) })?.firstChangedLine).toBe(5);
  });
  it("uses source view when no hunk overlaps or the bytes are equal", () => {
    expect(
      sourcePatch({
        file,
        base: text(base),
        head: text(head),
        ranges: [{ file: file.path, side: "base", fromLine: 15, toLine: 15 }],
      }),
    ).toBeUndefined();
    expect(sourcePatch({ file, base: "a\n", head: "a\n" })).toBeUndefined();
  });
  it("preserves rename paths and missing-final-newline markers", () => {
    expect(
      sourcePatch({
        file: { ...file, previousPath: "src/old.ts", status: "renamed" },
        base: "a",
        head: "b",
      }),
    ).toEqual({
      firstChangedLine: 1,
      text: "diff --git a/src/old.ts b/src/a.ts\nrename from src/old.ts\nrename to src/a.ts\n--- a/src/old.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n",
    });
  });
  it("uses absent file sides for added and deleted files", () => {
    expect(sourcePatch({ file: { ...file, status: "added" }, base: "", head: "new\n" })?.text).toBe(
      "diff --git a/src/a.ts b/src/a.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/a.ts\n@@ -0,0 +1,1 @@\n+new\n",
    );
    expect(
      sourcePatch({ file: { ...file, status: "deleted" }, base: "old\n", head: "" })?.text,
    ).toBe(
      "diff --git a/src/a.ts b/src/a.ts\ndeleted file mode 100644\n--- a/src/a.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-old\n",
    );
  });
});

describe("contextPatch", () => {
  const content = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
  const hunk = (fromLine: number, toLine: number) => {
    const lines = contextPatch({
      path: "infra/root.yaml",
      content,
      ranges: [{ fromLine, toLine }],
    })!.split("\n");
    const header = lines.findIndex((line) => line.startsWith("@@"));
    return { header: lines[header], body: lines.slice(header + 1, -1) };
  };

  it("frames the range with three lines of context and a Git header", () => {
    expect(
      contextPatch({ path: "infra/root.yaml", content, ranges: [{ fromLine: 45, toLine: 55 }] }),
    ).toMatch(
      /^diff --git a\/infra\/root\.yaml b\/infra\/root\.yaml\n--- a\/infra\/root\.yaml\n\+\+\+ b\/infra\/root\.yaml\n@@ -42,17 \+42,17 @@\n line 42\n/,
    );
    const { header, body } = hunk(45, 55);
    expect(header).toBe("@@ -42,17 +42,17 @@");
    expect(body).toHaveLength(17);
    expect(body.every((line) => line.startsWith(" "))).toBe(true);
    expect(body.at(-1)).toBe(" line 58");
  });
  it("clamps the window to the file", () => {
    expect(hunk(1, 2).header).toBe("@@ -1,5 +1,5 @@");
    expect(hunk(58, 60).header).toBe("@@ -55,6 +55,6 @@");
  });
  it("frames each range in its own hunk and merges windows that touch", () => {
    const headers = (ranges: { fromLine: number; toLine: number }[]) =>
      contextPatch({ path: "a.ts", content, ranges })!
        .split("\n")
        .filter((line) => line.startsWith("@@"));
    expect(
      headers([
        { fromLine: 40, toLine: 41 },
        { fromLine: 5, toLine: 6 },
      ]),
    ).toEqual(["@@ -2,8 +2,8 @@", "@@ -37,8 +37,8 @@"]);
    expect(
      headers([
        { fromLine: 5, toLine: 6 },
        { fromLine: 13, toLine: 14 },
      ]),
    ).toEqual(["@@ -2,16 +2,16 @@"]);
  });
  it("marks a missing final newline and skips ranges past the end", () => {
    expect(
      contextPatch({ path: "a.ts", content: "a\nb\nc", ranges: [{ fromLine: 3, toLine: 3 }] }),
    ).toBe(
      "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,3 @@\n a\n b\n c\n\\ No newline at end of file\n",
    );
    const ten = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
    expect(
      contextPatch({ path: "a.ts", content: ten, ranges: [{ fromLine: 12, toLine: 14 }] }),
    ).toBeUndefined();
    expect(
      contextPatch({ path: "a.ts", content: "", ranges: [{ fromLine: 1, toLine: 1 }] }),
    ).toBeUndefined();
  });
});
