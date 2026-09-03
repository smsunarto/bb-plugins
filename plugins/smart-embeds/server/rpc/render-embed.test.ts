import { describe, expect, test } from "bun:test";
import { stubHostContext } from "@bb-kit/core/testing";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { getSingularPatch } from "@pierre/diffs";

import { citationPatch } from "../lib/citation-patch.ts";
import { rangePatch } from "../lib/diff-range.ts";
import { renderEmbed } from "./render-embed.ts";

function context(options: { content?: string; patch?: string } = {}) {
  const calls: { read: unknown[]; diffPatch: unknown[] } = { read: [], diffPatch: [] };
  const bb = {
    sdk: {
      threads: {
        async get() {
          return { environmentId: "environment-1" };
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
        async read(input: unknown) {
          calls.read.push(input);
          return { contentEncoding: "utf8", content: options.content ?? "one\ntwo\nthree\n" };
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
