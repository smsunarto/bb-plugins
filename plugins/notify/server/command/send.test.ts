import { test } from "node:test";
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
    stdout: "Sent through macOS Notification Center.\n",
  });
  assert.deepEqual(shownNotifications(ctx), [
    { title: "T", body: "[Acme] hello there", soundName: null },
  ]);
});

test("send falls back to the invoking thread and reports failure", async () => {
  const ctx = createFakeContext({ available: false });
  const result = await send.execute({ ...ctx, threadId: "th-invoker" }, { message: "hi" });
  assert.deepEqual(result, {
    exitCode: 1,
    stdout: "Could not send the macOS notification.\n",
  });
  assert.deepEqual(shownNotifications(ctx), [{ title: "bb", body: "hi", soundName: null }]);
});

test("send's input rejects an invalid thread", async () => {
  const parsed = await send.input["~standard"].validate({ message: "hi", thread: "bad id" });
  assert.ok(parsed.issues);
  assert.match(parsed.issues.map((issue) => issue.message).join("; "), /not a thread id/);
});
