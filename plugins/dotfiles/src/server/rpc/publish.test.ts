import { test } from "bun:test";
import assert from "node:assert/strict";
import type { TaskResult } from "../domain.ts";
import { createFakeContext } from "../fake-context.ts";
import { publish } from "./publish.ts";

test("maps publishing to the fixed sync command", async () => {
  const result: TaskResult = { exitCode: 0, output: "done" };
  const ctx = createFakeContext({ run: async () => result });

  assert.deepEqual(await publish.execute(ctx), result);
  assert.deepEqual(
    ctx.git.run.mock.calls.map(([, command]) => command),
    ["mise run sync"],
  );
  assert.deepEqual(ctx.harness.logEntries, [
    { level: "info", message: "running publish: mise run sync" },
  ]);
});
