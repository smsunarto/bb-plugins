import { test } from "node:test";
import assert from "node:assert/strict";

import { createFakeContext, queuedNotifications } from "../fake-context.ts";
import { send } from "./send.ts";

test("send posts the message and prints the queued line", async () => {
  const ctx = createFakeContext({
    projectName: (projectId) => Promise.resolve(projectId === "p1" ? "Acme" : null),
  });
  const result = await send.execute(
    { ...ctx, threadId: "outer", projectId: "p1" },
    { message: "hello there", title: "T", thread: "th-1" },
  );
  assert.deepEqual(result, { exitCode: 0, stdout: "Queued — a BB window is listening.\n" });
  assert.deepEqual(await queuedNotifications(ctx), [
    { id: 1, title: "T", body: "[Acme] hello there", threadId: "th-1", silent: true },
  ]);
});

test("send falls back to the invoking thread and prints the held line", async () => {
  const ctx = createFakeContext({ listening: false });
  const result = await send.execute({ ...ctx, threadId: "th-invoker" }, { message: "hi" });
  assert.deepEqual(result, {
    exitCode: 0,
    stdout: "Held — no BB window is open. It will appear when one is.\n",
  });
  assert.deepEqual(await queuedNotifications(ctx), [
    { id: 1, title: "bb", body: "hi", threadId: "th-invoker", silent: true },
  ]);
});

test("send's input rejects an invalid thread", async () => {
  const parsed = await send.input["~standard"].validate({ message: "hi", thread: "bad id" });
  assert.ok(parsed.issues);
  assert.match(parsed.issues.map((issue) => issue.message).join("; "), /not a thread id/);
});
