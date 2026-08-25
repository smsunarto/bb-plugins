import { test } from "node:test";
import assert from "node:assert/strict";

import { createFakeContext } from "../fake-context.ts";
import { status } from "./status.ts";

test("status exits 1 when the repo is missing", async () => {
  const result = await status.invoke(createFakeContext({ repoExists: () => false }));
  assert.deepEqual(result, { exitCode: 1, stderr: "dotfiles repo not found at /dotfiles\n" });
});

test("status prints the branch and two-column entries", async () => {
  const result = await status.invoke(
    createFakeContext({
      gitStatus: async () => ({
        branch: "feature",
        entries: [
          { status: "M", path: ".dotfiles/mcp.json" },
          { status: "??", path: ".dotfiles/new.txt" },
        ],
      }),
    }),
  );
  assert.deepEqual(result, {
    exitCode: 0,
    stdout: "branch: feature\nM  .dotfiles/mcp.json\n?? .dotfiles/new.txt",
  });
});

test("status prints clean when there are no entries", async () => {
  const result = await status.invoke(createFakeContext());
  assert.deepEqual(result, { exitCode: 0, stdout: "branch: main\nclean" });
});
