import { test } from "node:test";
import assert from "node:assert/strict";
import type { Context } from "../server/context.ts";
import type { TaskResult } from "../server/domain.ts";
import { createFakeRepository } from "../server/fake-repository.ts";
import { publish } from "./publish.ts";

test("maps publishing to the fixed sync command", async () => {
  const commands: string[] = [];
  const logs: string[] = [];
  const result: TaskResult = { exitCode: 0, output: "done" };
  const context: Context = {
    repository: createFakeRepository({
      run: async (_repoPath, command) => {
        commands.push(command);
        return result;
      },
    }),
    log: (message) => {
      logs.push(message);
    },
  };

  assert.deepEqual(await publish.handler(context), result);
  assert.deepEqual(commands, ["mise run sync"]);
  assert.deepEqual(logs, ["running publish: mise run sync"]);
});
