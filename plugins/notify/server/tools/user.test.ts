import { test } from "node:test";
import assert from "node:assert/strict";

import { createFakeContext, shownNotifications } from "../fake-context.ts";
import { user } from "./user.ts";

function invocation(threadId: string) {
  return { threadId, projectId: "project-test", signal: new AbortController().signal };
}

test("notify_user titles with the thread, tags the project, and strips markdown", async () => {
  const lookups: string[] = [];
  const ctx = createFakeContext({
    thread: { title: "Fix CI", titleFallback: null, projectId: "p1" },
    projectName: (projectId) => {
      lookups.push(projectId);
      return Promise.resolve("Acme");
    },
  });
  const result = await user.execute(
    { ...ctx, tool: invocation("th_1") },
    { message: "**Build** finished" },
  );
  assert.equal(result, "Notification sent through macOS Notification Center.");
  assert.deepEqual(lookups, ["p1"]);
  assert.deepEqual(shownNotifications(ctx), [
    { title: "Fix CI", body: "[Acme] Build finished", soundName: null },
  ]);
});

test("notify_user still delivers when the thread lookup throws", async () => {
  const ctx = createFakeContext();
  const result = await user.execute({ ...ctx, tool: invocation("th_1") }, { message: "hello" });
  assert.equal(result, "Notification sent through macOS Notification Center.");
  assert.deepEqual(shownNotifications(ctx), [{ title: "bb", body: "hello", soundName: null }]);
});

test("notify_user reports native delivery failure", async () => {
  const ctx = createFakeContext({ available: false });
  const result = await user.execute({ ...ctx, tool: invocation("th_1") }, { message: "hello" });
  assert.equal(result, "The macOS notification could not be sent.");
  assert.equal(shownNotifications(ctx).length, 1);
});
