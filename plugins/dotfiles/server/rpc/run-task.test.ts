import { mock, test } from "bun:test";
import assert from "node:assert/strict";
import type { TaskResult } from "../domain.ts";
import { createFakeContext } from "../fake-context.ts";
import { runTask } from "./run-task.ts";

test("maps safe task ids to fixed commands", async () => {
  const log = mock<(message: string) => void>();
  const result: TaskResult = { exitCode: 0, output: "done" };
  const ctx = createFakeContext(
    {
      run: async () => result,
    },
    { log },
  );

  assert.deepEqual(await runTask.execute(ctx, { task: "check:skills" }), result);
  assert.deepEqual(
    ctx.git.run.mock.calls.map(([, command]) => command),
    ["mise run check:skills"],
  );
  assert.deepEqual(log.mock.calls, [["running task check:skills: mise run check:skills"]]);
});
