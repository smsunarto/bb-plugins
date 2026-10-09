import { test } from "bun:test";
import assert from "node:assert/strict";
import type { TaskResult } from "../../shared/domain.ts";
import { createFakeContext } from "../fake-context.ts";
import { runTask } from "./run-task.ts";

test("maps safe task ids to fixed commands", async () => {
  const result: TaskResult = { exitCode: 0, output: "done" };
  const ctx = createFakeContext({ run: async () => result });

  assert.deepEqual(await runTask.execute(ctx, { task: "check:skills" }), result);
  assert.deepEqual(
    ctx.git.run.mock.calls.map(([target, command]) => [target.hostId, command]),
    [["host_server", "mise run check:skills"]],
  );
  assert.deepEqual(ctx.harness.logEntries, [
    {
      level: "info",
      message: "running task check:skills on codex@cardinal: mise run check:skills",
    },
  ]);
});

test("runs on the machine the panel asked for", async () => {
  const ctx = createFakeContext();

  await runTask.execute(ctx, { hostId: "host_mac", task: "render" });

  assert.deepEqual(
    ctx.git.run.mock.calls.map(([target, command]) => [target.hostId, command]),
    [["host_mac", "mise run render"]],
  );
});
