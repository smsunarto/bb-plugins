import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

test("a cleaned-up workspace points at Restore workspace instead of a missing git workspace", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "gh-stack",
    sdk: {
      threads: {
        get: async () => makeThreadResponse({ id: "thr_archived", environmentId: "env_1" }),
      },
      environments: {
        get: async () => ({
          status: "destroyed",
          path: null,
          isGitRepo: false,
        }),
      },
    },
  });
  await plugin(bb);
  const result = await harness.behavior.callRpc("checkoutBranch", {
    threadId: "thr_archived",
    branch: "feature",
  });
  assert.deepEqual(result, {
    ok: false,
    message:
      "This thread's workspace was cleaned up. Unarchive the thread if it is archived, then use Restore workspace to bring it back.",
    detail: null,
  });
  await harness.lifecycle.dispose();
});
