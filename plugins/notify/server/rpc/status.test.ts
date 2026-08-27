import { test } from "node:test";
import assert from "node:assert/strict";

import { createFakeContext } from "../fake-context.ts";
import { status } from "./status.ts";

test("status reports filters without transport state", async () => {
  const ctx = createFakeContext({
    settings: {
      notifyOnIdle: false,
      minRunSeconds: "2.5",
      sound: "Glass",
      agentTool: true,
    },
  });
  const result = await status.execute(ctx);
  assert.deepEqual(result, {
    notifyOnIdle: false,
    notifyOnFailed: true,
    includeChildThreads: false,
    includeHiddenThreads: false,
    minRunSeconds: 2.5,
    sound: "Glass",
    agentTool: true,
  });
});
