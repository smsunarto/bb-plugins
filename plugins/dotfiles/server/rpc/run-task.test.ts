import { test } from "node:test";
import assert from "node:assert/strict";
import type { TaskResult } from "../domain.ts";
import { createFakeContext } from "../fake-context.ts";
import { runTask } from "./run-task.ts";

test("maps safe task ids to fixed commands", async () => {
  const commands: string[] = [];
  const logs: string[] = [];
  const result: TaskResult = { exitCode: 0, output: "done" };
  const context = createFakeContext(
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

  assert.deepEqual(await runTask.handler(context, { task: "check:skills" }), result);
  assert.deepEqual(commands, ["mise run check:skills"]);
  assert.deepEqual(logs, ["running task check:skills: mise run check:skills"]);
});
