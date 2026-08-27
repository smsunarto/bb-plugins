import { mock, test } from "bun:test";
import assert from "node:assert/strict";

import { createFakeContext, shownNotifications } from "../fake-context.ts";
import { user } from "./user.ts";

function invocation(threadId: string) {
  return { threadId, projectId: "project-test", signal: new AbortController().signal };
}

test("notify_user titles with the thread, tags the project, and strips markdown", async () => {
  const projectName = mock(async () => "Acme");
  const ctx = createFakeContext({
    thread: { title: "Fix CI", titleFallback: null, projectId: "p1" },
    projectName,
  });
  const result = await user.execute(
    { ...ctx, tool: invocation("th_1") },
    { message: "**Build** finished" },
  );
  assert.equal(result, "Notification shown by BB.");
  assert.deepEqual(projectName.mock.calls, [["p1"]]);
  assert.deepEqual(shownNotifications(ctx), [
    { title: "Fix CI", body: "[Acme] Build finished", threadId: "th_1", silent: true, play: null },
  ]);
});

test("notify_user still delivers when the thread lookup throws", async () => {
  const ctx = createFakeContext();
  const result = await user.execute({ ...ctx, tool: invocation("th_1") }, { message: "hello" });
  assert.equal(result, "Notification shown by BB.");
  assert.deepEqual(shownNotifications(ctx), [
    { title: "bb", body: "hello", threadId: "th_1", silent: true, play: null },
  ]);
});

test("notify_user reports that no renderer is available", async () => {
  const ctx = createFakeContext({ available: false });
  const result = await user.execute({ ...ctx, tool: invocation("th_1") }, { message: "hello" });
  assert.equal(
    result,
    "Notification not shown. Keep a BB desktop window open and check notification permission.",
  );
  assert.equal(shownNotifications(ctx).length, 1);
});
