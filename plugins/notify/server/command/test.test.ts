import { test as testCase } from "node:test";
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
    stdout: "Sent through macOS Notification Center.\n",
  });
  assert.deepEqual(shownNotifications(ctx), [
    {
      title: "bb notify",
      body: "[Acme] Notifications are working, even with every BB window closed.",
      soundName: null,
    },
  ]);
});

testCase("test reports native delivery failure outside a thread", async () => {
  const ctx = createFakeContext({ available: false });
  const result = await test.execute(ctx);
  assert.deepEqual(result, {
    exitCode: 1,
    stdout: "Could not send the macOS notification.\n",
  });
  assert.deepEqual(shownNotifications(ctx), [
    {
      title: "bb notify",
      body: "Notifications are working, even with every BB window closed.",
      soundName: null,
    },
  ]);
});
