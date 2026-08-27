import { test } from "node:test";
import assert from "node:assert/strict";
import { CommandError } from "@bb-kit/core/command";

import { createFakeContext } from "../fake-context.ts";
import { sync } from "./sync.ts";

test("sync throws when the repo is missing", async () => {
  await assert.rejects(
    () => Promise.resolve(sync.execute(createFakeContext({ repoExists: () => false }), { publish: false })),
    (error: unknown) => {
      assert.ok(error instanceof CommandError);
      assert.equal(error.message, "dotfiles repo not found at /dotfiles");
      return true;
    },
  );
});

test("sync without --publish runs the pull-only task", async () => {
  const commands: string[] = [];
  const result = await sync.execute(
    createFakeContext({
      run: async (_repoPath, command) => {
        commands.push(command);
        return { exitCode: 0, output: "pulled" };
      },
    }),
    { publish: false },
  );
  assert.deepEqual(result, { exitCode: 0, stdout: "pulled" });
  assert.deepEqual(commands, ["mise run sync:pull"]);
});

test("sync --publish publishes instead of pulling", async () => {
  const commands: string[] = [];
  const result = await sync.execute(
    createFakeContext({
      run: async (_repoPath, command) => {
        commands.push(command);
        return { exitCode: 1, output: "push rejected" };
      },
    }),
    { publish: true },
  );
  assert.deepEqual(result, { exitCode: 1, stdout: "push rejected" });
  assert.deepEqual(commands, ["mise run sync"]);
});
