import { test as testCase } from "node:test";
import assert from "node:assert/strict";

import { createFakeContext, queuedNotifications } from "../fake-context.ts";
import { test } from "./test.ts";

testCase("test posts the sample notification from the invoking thread", async () => {
  const context = createFakeContext({
    projectName: (projectId) => Promise.resolve(projectId === "p1" ? "Acme" : null),
  });
  const result = await test.invoke(context, [], { cli: { threadId: "th-1", projectId: "p1" } });
  assert.deepEqual(result, { exitCode: 0, stdout: "Queued — a BB window is listening.\n" });
  assert.deepEqual(await queuedNotifications(context), [
    {
      id: 1,
      title: "bb notify",
      body: "[Acme] Notifications are working. Click to open the thread this came from.",
      threadId: "th-1",
      silent: true,
    },
  ]);
});

testCase("test prints the held line outside a thread", async () => {
  const context = createFakeContext({ listening: false });
  const result = await test.invoke(context);
  assert.deepEqual(result, {
    exitCode: 0,
    stdout: "Held — no BB window is open. It will appear when one is.\n",
  });
  assert.deepEqual(await queuedNotifications(context), [
    {
      id: 1,
      title: "bb notify",
      body: "Notifications are working. Click to open the thread this came from.",
      threadId: null,
      silent: true,
    },
  ]);
});
