import { test } from "bun:test";
import assert from "node:assert/strict";
import { CommandError } from "@bb-kit/core/command";

import { createFakeContext } from "../fake-context.ts";
import { status } from "./status.ts";

test("status throws when the repo is missing", async () => {
  await assert.rejects(
    () => Promise.resolve(status.execute(createFakeContext({ repoExists: () => false }))),
    (error: unknown) => {
      assert.ok(error instanceof CommandError);
      assert.equal(error.message, "dotfiles repo not found at /dotfiles");
      return true;
    },
  );
});

test("status prints the branch and two-column entries", async () => {
  const result = await status.execute(
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
  const result = await status.execute(createFakeContext());
  assert.deepEqual(result, { exitCode: 0, stdout: "branch: main\nclean" });
});
