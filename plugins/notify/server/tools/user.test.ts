import { test } from "node:test";
import assert from "node:assert/strict";

import { createFakeContext, queuedNotifications } from "../fake-context.ts";
import { user } from "./user.ts";

function invocation(threadId: string) {
  return { threadId, projectId: "project-test", signal: new AbortController().signal };
}

test("notify_user titles with the thread, tags the project, and strips markdown", async () => {
  const lookups: string[] = [];
  const context = createFakeContext({
    thread: { title: "Fix CI", titleFallback: null, projectId: "p1" },
    projectName: (projectId) => {
      lookups.push(projectId);
      return Promise.resolve("Acme");
    },
  });
  const result = await user.execute(
    { ...context, tool: invocation("th_1") },
    { message: "**Build** finished" },
  );
  assert.equal(result, "Notification queued; a BB window is listening.");
  assert.deepEqual(lookups, ["p1"]);
  assert.deepEqual(await queuedNotifications(context), [
    { id: 1, title: "Fix CI", body: "[Acme] Build finished", threadId: "th_1", silent: true },
  ]);
});

test("notify_user still delivers when the thread lookup throws", async () => {
  const context = createFakeContext();
  const result = await user.execute({ ...context, tool: invocation("th_1") }, { message: "hello" });
  assert.equal(result, "Notification queued; a BB window is listening.");
  assert.deepEqual(await queuedNotifications(context), [
    { id: 1, title: "bb", body: "hello", threadId: "th_1", silent: true },
  ]);
});

test("notify_user reports a held notification when no window listens", async () => {
  const context = createFakeContext({ listening: false });
  const result = await user.execute({ ...context, tool: invocation("th_1") }, { message: "hello" });
  assert.equal(result, "No BB window is open; the notification will appear when one is.");
  assert.equal((await queuedNotifications(context)).length, 1);
});
