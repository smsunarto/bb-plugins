import { mock, test } from "bun:test";
import assert from "node:assert/strict";

import { createFakeContext, shownNotifications } from "../fake-context.ts";
import { send } from "./send.ts";

test("send resolves the project and posts through delivery", async () => {
  const projectName = mock(async () => "Acme");
  const ctx = createFakeContext({
    projectName,
  });
  const result = await send.execute(ctx, {
    message: "**Build** finished",
    title: "CI",
    threadId: "th_1",
    projectId: "p1",
  });
  assert.deepEqual(result, { listening: true });
  assert.deepEqual(projectName.mock.calls, [["p1"]]);
  assert.deepEqual(shownNotifications(ctx), [
    {
      title: "CI",
      body: "[Acme] Build finished",
      soundName: null,
    },
  ]);
});

test("send defaults the title, thread, and project", async () => {
  const ctx = createFakeContext();
  const result = await send.execute(ctx, { message: "hello" });
  assert.deepEqual(result, { listening: true });
  assert.deepEqual(shownNotifications(ctx), [{ title: "bb", body: "hello", soundName: null }]);
});

test("send input rejects a whitespace-only message and trims a padded one", () => {
  assert.equal(send.input.safeParse({ message: "   " }).success, false);
  assert.equal(send.input.safeParse({ message: "" }).success, false);
  assert.equal(send.input.parse({ message: "  hi  " }).message, "hi");
});

test("send reports native delivery failure", async () => {
  const ctx = createFakeContext({ available: false });
  const result = await send.execute(ctx, { message: "hello" });
  assert.deepEqual(result, { listening: false });
  assert.equal(shownNotifications(ctx).length, 1);
});
