import { test as testCase } from "bun:test";
import assert from "node:assert/strict";

import { createFakeContext, shownNotifications } from "../fake-context.ts";
import { test } from "./test.ts";

testCase("test posts a manual sample notification even from an invoking thread", async () => {
  const ctx = createFakeContext({
    projectName: (projectId) => Promise.resolve(projectId === "p1" ? "Acme" : null),
  });
  const result = await test.execute({ ...ctx, threadId: "th-1", projectId: "p1" });
  assert.deepEqual(result, {
    exitCode: 0,
    stdout: "Notification shown by BB.\n",
  });
  assert.deepEqual(shownNotifications(ctx), [
    {
      title: "bb notify",
      body: "[Acme] Notifications are working.",
      threadId: null,
      silent: true,
      play: null,
    },
  ]);
});

testCase("test reports that no renderer is listening outside a thread", async () => {
  const ctx = createFakeContext({ available: false });
  const result = await test.execute(ctx);
  assert.deepEqual(result, {
    exitCode: 1,
    stdout:
      "Notification not shown. Keep a BB desktop window open and check notification permission.\n",
  });
  assert.deepEqual(shownNotifications(ctx), [
    {
      title: "bb notify",
      body: "Notifications are working.",
      threadId: null,
      silent: true,
      play: null,
    },
  ]);
});

testCase("test does not claim success for an unexpected suppressed outcome", async () => {
  const ctx = createFakeContext({ outcome: "suppressed" });
  const result = await test.execute({ ...ctx, threadId: "th-1" });
  assert.deepEqual(result, {
    exitCode: 1,
    stdout: "Notification suppressed. The diagnostic did not create one.\n",
  });
  assert.equal(shownNotifications(ctx)[0]?.threadId, null);
});
