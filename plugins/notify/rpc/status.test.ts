import { test } from "node:test";
import assert from "node:assert/strict";

import { createFakeContext, fakeSettings } from "../server/fake-context.ts";
import { status } from "./status.ts";

test("status reports the window, the queue, and the filters", async () => {
  const context = createFakeContext();
  await context.notifications.enqueue({
    title: "t",
    body: "b",
    threadId: null,
    silent: true,
    play: null,
  });
  const result = await status.handler(context);
  assert.deepEqual(result, {
    listening: true,
    polling: 1,
    held: 1,
    notifyOnIdle: true,
    notifyOnFailed: true,
    includeChildThreads: false,
    includeHiddenThreads: false,
    minRunSeconds: 0,
    sound: "off",
    agentTool: false,
  });
});

test("status parses minRunSeconds and reflects a closed window", async () => {
  const context = createFakeContext({
    windowIsListening: () => false,
    pollingCount: () => 0,
    settings: () =>
      fakeSettings({
        notifyOnIdle: false,
        minRunSeconds: "2.5",
        sound: "Glass",
        agentTool: true,
      }),
  });
  const result = await status.handler(context);
  assert.equal(result.listening, false);
  assert.equal(result.polling, 0);
  assert.equal(result.held, 0);
  assert.equal(result.notifyOnIdle, false);
  assert.equal(result.minRunSeconds, 2.5);
  assert.equal(result.sound, "Glass");
  assert.equal(result.agentTool, true);
});
