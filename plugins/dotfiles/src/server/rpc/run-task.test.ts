import { cleanRepo, serverTarget } from "../fake-git.ts";
import { test } from "bun:test";
import assert from "node:assert/strict";
import type { TaskResult } from "../../shared/domain.ts";
import { createFakeContext } from "../fake-context.ts";
import { runTask } from "./run-task.ts";

test("maps safe task ids to fixed commands", async () => {
  const result: TaskResult = { exitCode: 0, output: "done" };
  const ctx = createFakeContext({ run: async () => result });

  assert.deepEqual(await runTask(ctx, { task: "check:skills" }), result);
  assert.deepEqual(
    ctx.git.run.mock.calls.map(([target, command]) => [target.hostId, command]),
    [["host_server", "mise run check:skills"]],
  );
  assert.deepEqual(ctx.harness.logEntries, [
    {
      level: "info",
      message: "running task check:skills on linux-builder: mise run check:skills",
    },
  ]);
});

test("runs on the machine the panel asked for", async () => {
  const ctx = createFakeContext();

  await runTask(ctx, { hostId: "host_mac", task: "render" });

  assert.deepEqual(
    ctx.git.run.mock.calls.map(([target, command]) => [target.hostId, command]),
    [["host_mac", "mise run render"]],
  );
});

test("refreshes and verifies installed agent copies on the selected machine", async () => {
  const ctx = createFakeContext();
  await runTask(ctx, { hostId: "host_mac", task: "install:agent-plugins" });
  assert.deepEqual(
    ctx.git.run.mock.calls.map(([target, command]) => [target.hostId, command]),
    [["host_mac", "mise run install:agent-plugins && mise run check:live"]],
  );
});

test("guarded apply refuses a different canonical checkout", async () => {
  const ctx = createFakeContext();
  await assert.rejects(
    runTask(ctx, { task: "render", expectedRepoPath: "/different" }),
    /another checkout/,
  );
  assert.equal(ctx.git.run.mock.calls.length, 0);
});

test("guarded apply runs the same target it validated even if settings change", async () => {
  let configured = "/first";
  const ctx = createFakeContext({
    target: async () => ({ ...serverTarget, repoPath: configured }),
    inspect: async (target) => {
      configured = "/second";
      return cleanRepo(target, { repoPath: "/first" });
    },
  });
  await runTask(ctx, { task: "render", expectedRepoPath: "/first" });
  assert.equal(ctx.git.target.mock.calls.length, 1);
  assert.equal(ctx.git.run.mock.calls[0]?.[0].repoPath, "/first");
});
