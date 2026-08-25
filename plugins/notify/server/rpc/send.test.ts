import { test } from "node:test";
import assert from "node:assert/strict";

import { createFakeContext, queuedNotifications } from "../fake-context.ts";
import { send } from "./send.ts";

test("send resolves the project and posts through delivery", async () => {
  const lookups: string[] = [];
  const context = createFakeContext({
    projectName: (projectId) => {
      lookups.push(projectId);
      return Promise.resolve("Acme");
    },
  });
  const result = await send.handler(context, {
    message: "**Build** finished",
    title: "CI",
    threadId: "th_1",
    projectId: "p1",
  });
  assert.deepEqual(result, { listening: true });
  assert.deepEqual(lookups, ["p1"]);
  assert.deepEqual(await queuedNotifications(context), [
    {
      id: 1,
      title: "CI",
      body: "[Acme] Build finished",
      threadId: "th_1",
      silent: true,
    },
  ]);
});

test("send defaults the title, thread, and project", async () => {
  const context = createFakeContext();
  const result = await send.handler(context, { message: "hello" });
  assert.deepEqual(result, { listening: true });
  assert.deepEqual(await queuedNotifications(context), [
    { id: 1, title: "bb", body: "hello", threadId: null, silent: true },
  ]);
});

test("send input rejects a whitespace-only message and trims a padded one", () => {
  assert.equal(send.input.safeParse({ message: "   " }).success, false);
  assert.equal(send.input.safeParse({ message: "" }).success, false);
  assert.equal(send.input.parse({ message: "  hi  " }).message, "hi");
});

test("send reports a held notification when no window listens", async () => {
  const context = createFakeContext({ listening: false });
  const result = await send.handler(context, { message: "hello" });
  assert.deepEqual(result, { listening: false });
  assert.equal((await queuedNotifications(context)).length, 1);
});
