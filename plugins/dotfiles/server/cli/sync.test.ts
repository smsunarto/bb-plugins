import { test } from "node:test";
import assert from "node:assert/strict";

import { createFakeContext } from "../fake-context.ts";
import { sync } from "./sync.ts";

test("sync exits 1 when the repo is missing", async () => {
  const result = await sync.invoke(createFakeContext({ repoExists: () => false }));
  assert.deepEqual(result, { exitCode: 1, stderr: "dotfiles repo not found at /dotfiles\n" });
});

test("sync without --publish runs the pull-only task", async () => {
  const commands: string[] = [];
  const result = await sync.invoke(
    createFakeContext({
      run: async (_repoPath, command) => {
        commands.push(command);
        return { exitCode: 0, output: "pulled" };
      },
    }),
  );
  assert.deepEqual(result, { exitCode: 0, stdout: "pulled" });
  assert.deepEqual(commands, ["mise run sync:pull"]);
});

test("sync --publish publishes instead of pulling", async () => {
  const commands: string[] = [];
  const result = await sync.invoke(
    createFakeContext({
      run: async (_repoPath, command) => {
        commands.push(command);
        return { exitCode: 1, output: "push rejected" };
      },
    }),
    ["--publish"],
  );
  assert.deepEqual(result, { exitCode: 1, stdout: "push rejected" });
  assert.deepEqual(commands, ["mise run sync"]);
});
