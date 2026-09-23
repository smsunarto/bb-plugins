import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

const owner = makeThreadResponse({
  id: "thr_owner",
  projectId: "proj_1",
  environmentId: "env_1",
  providerId: "claude-code",
  title: "Owner title",
});

function loadPlugin(wait: () => Promise<unknown>) {
  const spawns: unknown[] = [];
  const deletes: unknown[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "gh-stack",
    sdk: {
      threads: {
        get: async () => owner,
        spawn: async (args: unknown) => {
          spawns.push(args);
          return makeThreadResponse({ id: "thr_helper" });
        },
        wait,
        output: async () => ({ output: 'Sure!\n"Fix the flaky test."' }),
        delete: async (args: unknown) => {
          deletes.push(args);
          return { ok: true };
        },
      },
      environments: {
        get: async () => ({ branchName: "main", defaultBranch: "main" }),
      },
    },
  });
  return { bb, harness, spawns, deletes };
}

test("suggestStackName spawns an owned helper thread and reads its output", async () => {
  const { bb, harness, spawns, deletes } = loadPlugin(async () => ({ matched: true }));
  await plugin(bb);
  const result = await harness.behavior.callRpc("suggestStackName", { threadId: "thr_owner" });
  assert.deepEqual(result, { name: "Fix the flaky test" });
  assert.equal(spawns.length, 1);
  assert.partialDeepStrictEqual(spawns[0], {
    projectId: "proj_1",
    environment: { type: "reuse", environmentId: "env_1" },
    visibility: "hidden",
    lifecycleOwnerThreadId: "thr_owner",
    pluginMetadata: { role: "suggest-stack-name", requestedByThreadId: "thr_owner" },
  });
  assert.deepEqual(deletes, [{ threadId: "thr_helper", childThreadsConfirmed: true }]);
  await harness.lifecycle.dispose();
});

test("suggestStackName falls back and deletes the helper when the wait fails", async () => {
  const { bb, harness, deletes } = loadPlugin(async () => {
    throw new Error("Timed out waiting for thread thr_helper to reach status idle.");
  });
  await plugin(bb);
  const result = await harness.behavior.callRpc("suggestStackName", { threadId: "thr_owner" });
  assert.deepEqual(result, { name: "Owner title" });
  assert.deepEqual(deletes, [{ threadId: "thr_helper", childThreadsConfirmed: true }]);
  await harness.lifecycle.dispose();
});
