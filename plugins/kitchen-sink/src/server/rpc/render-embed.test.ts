import { describe, expect, test } from "bun:test";
import { stubHostContext } from "@bb-kit/core/testing";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { getSingularPatch } from "@pierre/diffs";

import { citationPatch } from "../lib/citation-patch.ts";
import { rangePatch } from "../lib/diff-range.ts";
import { splitPatchFiles } from "../lib/patch-file.ts";
import { renderEmbed } from "./render-embed.ts";

function context(options: { content?: string; patch?: string; storage?: string } = {}) {
  const calls: { read: unknown[]; diffPatch: unknown[] } = { read: [], diffPatch: [] };
  const bb = {
    sdk: {
      threads: {
        async get() {
          return { environmentId: "environment-1" };
        },
        async storageLocation() {
          return { hostId: "host-1", storageRootPath: "/home/user/.bb/thread-storage/thread-1" };
        },
      },
      environments: {
        async get() {
          return {
            id: "environment-1",
            hostId: "host-1",
            path: "/workspace/project",
            mergeBaseBranch: "main",
            baseBranch: "main",
            defaultBranch: "main",
          };
        },
        async diffPatch(input: unknown) {
          calls.diffPatch.push(input);
          return {
            outcome: "available",
            patches:
              options.patch === undefined
                ? []
                : [{ path: "src/example.ts", patch: options.patch, truncated: false }],
          };
        },
      },
      files: {
        async read(input: { path: string }) {
          calls.read.push(input);
          const content = input.path.includes("thread-storage")
            ? (options.storage ?? "")
            : (options.content ?? "one\ntwo\nthree\n");
          return { contentEncoding: "utf8", content };
        },
      },
    },
    log: { warn() {} },
  } as unknown as BbPluginApi;
  return { ctx: stubHostContext({ bb }), calls };
}

describe("citationPatch", () => {
  test("keeps the source line numbers and adds bounded context", () => {
    const result = citationPatch("src/example.ts", "one\ntwo\nthree\nfour\nfive\n", 3, 4);
    expect(result).toEqual({
      label: "src/example.ts:L3-L4",
      patch:
        "diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1,5 +1,5 @@\n one\n two\n three\n four\n five\n",
    });
    if ("patch" in result) expect(() => getSingularPatch(result.patch)).not.toThrow();
  });

  test("rejects reversed and oversized ranges", () => {
    expect(citationPatch("x.ts", "one\ntwo", 2, 1)).toEqual({
      error: "The citation end line must not come before its start line.",
    });
    expect(citationPatch("x.ts", `${"line\n".repeat(205)}`, 1, 201)).toEqual({
      error: "A code citation can include at most 200 lines.",
    });
  });
});

describe("renderEmbed", () => {
  test("reads a citation through the environment host and root fence", async () => {
    const { ctx, calls } = context({ content: "one\ntwo\nthree\n" });
    const result = await renderEmbed.execute(ctx, {
      kind: "code",
      threadId: "thread-1",
      path: "src/example.ts",
      start: 2,
      end: 2,
    });

    expect(result.status).toBe("ready");
    expect(calls.read).toEqual([
      {
        hostId: "host-1",
        path: "/workspace/project/src/example.ts",
        rootPath: "/workspace/project",
      },
    ]);
  });

  test("loads branch and working-tree changes from the merge base", async () => {
    const patch =
      "diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-old\n+new\n";
    const { ctx, calls } = context({ patch });
    const result = await renderEmbed.execute(ctx, {
      kind: "diff",
      threadId: "thread-1",
      path: "src/example.ts",
    });

    expect(result).toMatchObject({ status: "ready", kind: "diff", patch });
    expect(calls.diffPatch).toEqual([
      {
        environmentId: "environment-1",
        paths: ["src/example.ts"],
        target: { type: "all", mergeBaseBranch: "main" },
      },
    ]);
  });

  test("rejects paths that can escape the worktree", async () => {
    const { ctx, calls } = context();
    const result = await renderEmbed.execute(ctx, {
      kind: "code",
      threadId: "thread-1",
      path: "../secret.txt",
    });

    expect(result).toEqual({
      status: "error",
      message: "Expected a worktree-relative file path.",
    });
    expect(calls.read).toEqual([]);
  });
});

describe("rangePatch", () => {
  const patch = [
    "diff --git a/src/example.ts b/src/example.ts",
    "--- a/src/example.ts",
    "+++ b/src/example.ts",
    "@@ -1,3 +1,3 @@",
    " one",
    "-two",
    "+TWO",
    " three",
    "@@ -10,6 +10,7 @@ function later() {",
    " ten",
    " eleven",
    "-twelve",
    "+twelve!",
    "+twelve-and-a-half",
    " thirteen",
    " fourteen",
    " fifteen",
    "\\ No newline at end of file",
    "",
  ].join("\n");

  test("keeps only the hunk lines near the requested new-side range", () => {
    const result = rangePatch("src/example.ts", patch, 12, 13);
    expect(result).toEqual({
      label: "src/example.ts:L12-L13",
      patch: [
        "diff --git a/src/example.ts b/src/example.ts",
        "--- a/src/example.ts",
        "+++ b/src/example.ts",
        "@@ -10,5 +10,6 @@ function later() {",
        " ten",
        " eleven",
        "-twelve",
        "+twelve!",
        "+twelve-and-a-half",
        " thirteen",
        " fourteen",
        "",
      ].join("\n"),
    });
    if ("patch" in result) expect(() => getSingularPatch(result.patch)).not.toThrow();
  });

  test("recounts a trimmed hunk header and drops untouched hunks", () => {
    const result = rangePatch("src/example.ts", patch, 1, 1);
    expect(result).toEqual({
      label: "src/example.ts:L1",
      patch:
        "diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n",
    });
    expect(rangePatch("src/example.ts", patch, 10, 10)).toEqual({
      label: "src/example.ts:L10",
      patch:
        "diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -10,3 +10,3 @@ function later() {\n ten\n eleven\n-twelve\n+twelve!\n",
    });
  });

  test("reports an empty range and a reversed range", () => {
    expect(rangePatch("src/example.ts", patch, 16, 16)).toEqual({
      empty: "No changes found in src/example.ts:L16.",
    });
    expect(rangePatch("src/example.ts", patch, 40, 50)).toEqual({
      empty: "No changes found in src/example.ts:L40-L50.",
    });
    expect(rangePatch("src/example.ts", patch, 5, 2)).toEqual({
      error: "The diff end line must not come before its start line.",
    });
  });
});

test("renderEmbed trims a diff to the requested range", async () => {
  const patch =
    "diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1,6 +1,6 @@\n one\n-two\n+TWO\n three\n four\n-five\n+FIVE\n six\n";
  const { ctx } = context({ patch });
  const result = await renderEmbed.execute(ctx, {
    kind: "diff",
    threadId: "thread-1",
    path: "src/example.ts",
    start: 5,
    end: 5,
  });
  expect(result).toEqual({
    status: "ready",
    kind: "diff",
    path: "src/example.ts",
    label: "src/example.ts:L5",
    patch:
      "diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -3,4 +3,4 @@\n three\n four\n-five\n+FIVE\n six\n",
    truncated: false,
  });
});

const multiFilePatch = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,3 @@",
  " one",
  "-two",
  "+TWO",
  " three",
  "diff --git a/src/b.ts b/src/b.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/b.ts",
  "@@ -0,0 +1 @@",
  "+hello",
  "",
].join("\n");

describe("splitPatchFiles", () => {
  test("splits a git patch per file and keeps each file's own header", () => {
    const files = splitPatchFiles(multiFilePatch);
    expect(files.map((file) => file.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(files[1]?.patch).toBe(
      "diff --git a/src/b.ts b/src/b.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/b.ts\n@@ -0,0 +1 @@\n+hello\n",
    );
    for (const file of files) expect(() => getSingularPatch(file.patch)).not.toThrow();
  });

  test("splits a plain unified diff on its file headers and skips chunks without hunks", () => {
    const files = splitPatchFiles(
      "some notes\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n--- y.ts\n+++ y.ts\n@@ -1 +1 @@\n-c\n+d\n--- z.ts\n+++ z.ts\n",
    );
    expect(files.map((file) => file.path)).toEqual(["x.ts", "y.ts"]);
  });
});

describe("renderEmbed patch", () => {
  test("reads the patch under the thread storage root fence and infers a single file", async () => {
    const storage =
      "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
    const { ctx, calls } = context({ storage });
    const result = await renderEmbed.execute(ctx, {
      kind: "patch",
      threadId: "thread-1",
      file: "proposal.patch",
    });
    expect(result).toEqual({
      status: "ready",
      kind: "patch",
      path: "src/a.ts",
      label: "src/a.ts",
      patch: storage,
      truncated: false,
    });
    expect(calls.read).toEqual([
      {
        hostId: "host-1",
        path: "/home/user/.bb/thread-storage/thread-1/proposal.patch",
        rootPath: "/home/user/.bb/thread-storage/thread-1",
      },
    ]);
  });

  test("selects one file from a multi-file patch and trims it to a range", async () => {
    const { ctx } = context({ storage: multiFilePatch });
    expect(
      await renderEmbed.execute(ctx, { kind: "patch", threadId: "thread-1", file: "p.patch" }),
    ).toEqual({ status: "error", message: "p.patch touches 2 files. Add path= to choose one." });
    expect(
      await renderEmbed.execute(ctx, {
        kind: "patch",
        threadId: "thread-1",
        file: "p.patch",
        path: "src/c.ts",
      }),
    ).toEqual({ status: "error", message: "p.patch has no changes for src/c.ts." });
    expect(
      await renderEmbed.execute(ctx, {
        kind: "patch",
        threadId: "thread-1",
        file: "p.patch",
        path: "src/a.ts",
        start: 2,
        end: 2,
      }),
    ).toEqual({
      status: "ready",
      kind: "patch",
      path: "src/a.ts",
      label: "src/a.ts:L2",
      patch:
        "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n",
      truncated: false,
    });
  });

  test("rejects patch files that can escape thread storage and reports an empty patch", async () => {
    const { ctx, calls } = context({ storage: "not a diff\n" });
    expect(
      await renderEmbed.execute(ctx, { kind: "patch", threadId: "thread-1", file: "../x.patch" }),
    ).toEqual({ status: "error", message: "Expected a thread-storage-relative patch file." });
    expect(calls.read).toEqual([]);
    expect(
      await renderEmbed.execute(ctx, { kind: "patch", threadId: "thread-1", file: "x.patch" }),
    ).toEqual({ status: "empty", message: "No file changes found in x.patch." });
  });
});
