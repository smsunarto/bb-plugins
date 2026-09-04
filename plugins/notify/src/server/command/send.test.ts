import { test } from "bun:test";
import assert from "node:assert/strict";

import { createFakeContext, shownNotifications } from "../fake-context.ts";
import { send } from "./send.ts";

test("send posts the message and prints the sent line", async () => {
  const ctx = createFakeContext({
    projectName: (projectId) => Promise.resolve(projectId === "p1" ? "Acme" : null),
    thread: { title: null, titleFallback: null, projectId: "p1" },
  });
  const result = await send.execute(
    { ...ctx, threadId: "outer", projectId: "p1" },
    { message: "hello there", title: "T", thread: "th-1" },
  );
  assert.deepEqual(result, {
    exitCode: 0,
    stdout: "Notification shown by BB.\n",
  });
  assert.deepEqual(shownNotifications(ctx), [
    { title: "T", body: "[Acme] hello there", threadId: "th-1", silent: true, play: null },
  ]);
});

test("send falls back to the invoking thread and reports failure", async () => {
  const ctx = createFakeContext({ available: false });
  const result = await send.execute({ ...ctx, threadId: "th-invoker" }, { message: "hi" });
  assert.deepEqual(result, {
    exitCode: 1,
    stdout:
      "Notification not shown. Keep a BB desktop window open and check notification permission.\n",
  });
  assert.deepEqual(shownNotifications(ctx), [
    { title: "bb", body: "hi", threadId: "th-invoker", silent: true, play: null },
  ]);
});

test("send's input rejects an invalid thread", async () => {
  const parsed = await send.input["~standard"].validate({ message: "hi", thread: "bad id" });
  assert.ok(parsed.issues);
  assert.match(parsed.issues.map((issue) => issue.message).join("; "), /not a thread id/);
});

test("send reports a suppressed target without claiming it was shown", async () => {
  const ctx = createFakeContext({ outcome: "suppressed" });
  const result = await send.execute(
    { ...ctx, threadId: "th-invoker" },
    { message: "hi", thread: "th-invoker" },
  );
  assert.deepEqual(result, {
    exitCode: 0,
    stdout: "Notification suppressed because the thread is already in view.\n",
  });
});

test("send distinguishes a renderer failure from renderer unavailability", async () => {
  const ctx = createFakeContext({ outcome: "failed" });
  const result = await send.execute(ctx, { message: "hi" });
  assert.deepEqual(result, {
    exitCode: 1,
    stdout: "Notification not shown. BB could not create it.\n",
  });
});
