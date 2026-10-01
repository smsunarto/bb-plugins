import { test } from "bun:test";
import assert from "node:assert/strict";
import { PluginCliError } from "@bb-kit/core/command";

import { createFakeContext } from "../fake-context.ts";
import { list } from "./list.ts";

const noArgs = { options: {}, positionals: {}, passthrough: [], help: "" };

test("list throws when the repo is missing", async () => {
  await assert.rejects(
    () => Promise.resolve(list.execute(createFakeContext({ repoExists: () => false }), noArgs)),
    (error: unknown) => {
      assert.ok(error instanceof PluginCliError);
      assert.equal(error.exitCode, 1);
      assert.equal(error.message, "dotfiles repo not found at /dotfiles");
      return true;
    },
  );
});

test("list prints grouped files with bracketed flag suffixes", async () => {
  const result = await list.execute(
    createFakeContext({
      pathExists: (_repoPath, path) => path !== "mise.linux.toml",
      gitStatus: async () => ({
        branch: "main",
        entries: [{ status: "M", path: ".dotfiles/mcp.json" }],
      }),
    }),
    noArgs,
  );
  assert.equal(result.exitCode, 0);
  const stdout = result.stdout ?? "";
  assert.match(stdout, /^# Agent config$/m);
  assert.match(stdout, /^\s+\.dotfiles\/mcp\.json\s+\[dirty, renders\]$/m);
  assert.match(stdout, /^\s+mise\.linux\.toml\s+\[MISSING\]$/m);
  assert.match(stdout, /^# Settings overlays$/m);
});
