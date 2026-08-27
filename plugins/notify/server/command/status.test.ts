import { test } from "bun:test";
import assert from "node:assert/strict";

import { createFakeContext } from "../fake-context.ts";
import { status } from "./status.ts";

test("status prints direct delivery and every filter", async () => {
  const ctx = createFakeContext({
    settings: {
      notifyOnIdle: true,
      notifyOnFailed: false,
      includeChildThreads: false,
      includeHiddenThreads: true,
      minRunSeconds: "5",
      sound: "Glass",
      agentTool: true,
    },
  });
  const result = await status.execute(ctx);
  assert.deepEqual(result, {
    exitCode: 0,
    stdout:
      "delivery:   macOS Notification Center\n" +
      "on idle:    true\n" +
      "on failed:  false\n" +
      "children:   false\n" +
      "hidden:     true\n" +
      "min run:    5s\n" +
      "sound:      Glass\n" +
      "agent tool: notify_user\n",
  });
});
