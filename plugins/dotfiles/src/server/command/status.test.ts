import { test } from "bun:test";
import assert from "node:assert/strict";
import { PluginCliError } from "@get-bb/plugin-sdk";

import { createFakeContext } from "../fake-context.ts";
import { cleanRepo } from "../fake-git.ts";
import { status } from "./status.ts";

const noArgs = { options: {}, positionals: {}, passthrough: [], help: "" };

test("status throws when the repo is missing", async () => {
  await assert.rejects(
    () =>
      Promise.resolve(
        status(
          createFakeContext({
            inspect: async (target) => cleanRepo(target, { repoExists: false }),
          }),
        ).run(noArgs, {}),
      ),
    (error: unknown) => {
      assert.ok(error instanceof PluginCliError);
      assert.equal(error.exitCode, 1);
      assert.equal(error.message, "dotfiles repo not found at /dotfiles on linux-builder");
      return true;
    },
  );
});

test("status prints the branch and two-column entries", async () => {
  const result = await status(
    createFakeContext({
      inspect: async (target) =>
        cleanRepo(target, {
          branch: "feature",
          entries: [
            { status: "M", path: ".dotfiles/mcp.json" },
            { status: "??", path: ".dotfiles/new.txt" },
          ],
        }),
    }),
  ).run(noArgs, {});
  assert.deepEqual(result, {
    exitCode: 0,
    stdout: "branch: feature\nM  .dotfiles/mcp.json\n?? .dotfiles/new.txt",
    stderr: "host: linux-builder · repo: /dotfiles\n",
  });
});

test("status prints clean when there are no entries", async () => {
  const result = await status(createFakeContext()).run(noArgs, {});
  assert.deepEqual(result, {
    exitCode: 0,
    stdout: "branch: main\nclean",
    stderr: "host: linux-builder · repo: /dotfiles\n",
  });
});
