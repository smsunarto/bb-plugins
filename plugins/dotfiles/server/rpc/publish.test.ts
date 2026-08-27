import { test } from "node:test";
import assert from "node:assert/strict";
import type { TaskResult } from "../domain.ts";
import { createFakeContext } from "../fake-context.ts";
import { publish } from "./publish.ts";

test("maps publishing to the fixed sync command", async () => {
  const commands: string[] = [];
  const logs: string[] = [];
  const result: TaskResult = { exitCode: 0, output: "done" };
  const ctx = createFakeContext(
    {
      run: async (_repoPath, command) => {
        commands.push(command);
        return result;
      },
    },
    {
      log: (message) => {
        logs.push(message);
      },
    },
  );

  assert.deepEqual(await publish.execute(ctx), result);
  assert.deepEqual(commands, ["mise run sync"]);
  assert.deepEqual(logs, ["running publish: mise run sync"]);
});
