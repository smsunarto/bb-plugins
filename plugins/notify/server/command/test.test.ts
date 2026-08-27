import { test as testCase } from "bun:test";
import assert from "node:assert/strict";

import { createFakeContext, shownNotifications } from "../fake-context.ts";
import { test } from "./test.ts";

testCase("test posts the sample notification from the invoking thread", async () => {
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
      body: "[Acme] Notifications are working. Click to open this thread.",
      threadId: "th-1",
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
      body: "Notifications are working. Click to open this thread.",
      threadId: null,
      silent: true,
      play: null,
    },
  ]);
});
