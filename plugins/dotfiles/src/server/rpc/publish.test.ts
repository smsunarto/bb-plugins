import { test } from "bun:test";
import assert from "node:assert/strict";
import type { TaskResult } from "../../shared/domain.ts";
import { createFakeContext } from "../fake-context.ts";
import { publish } from "./publish.ts";

test("maps publishing to the fixed sync command on the requested machine", async () => {
  const result: TaskResult = { exitCode: 0, output: "done" };
  const ctx = createFakeContext({ run: async () => result });

  assert.deepEqual(await publish(ctx, { hostId: "host_mac" }), result);
  assert.deepEqual(
    ctx.git.run.mock.calls.map(([target, command]) => [target.hostId, command]),
    [["host_mac", "mise run sync"]],
  );
  assert.deepEqual(ctx.harness.logEntries, [
    { level: "info", message: "running publish on Local Mac: mise run sync" },
  ]);
});
