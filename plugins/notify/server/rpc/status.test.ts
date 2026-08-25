import { test } from "node:test";
import assert from "node:assert/strict";

import { notificationQueue } from "../delivery.ts";
import { createFakeContext } from "../fake-context.ts";
import { status } from "./status.ts";

test("status reports the window, the queue, and the filters", async () => {
  const context = createFakeContext();
  const delivery = notificationQueue(context.bb);
  await delivery.queue.enqueue({
    title: "t",
    body: "b",
    threadId: null,
    silent: true,
    play: null,
  });
  const ac = new AbortController();
  const waiting = delivery.waitForQueue(ac.signal, 60_000);
  const result = await status.handler(context);
  ac.abort();
  await waiting;
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
    listening: false,
    settings: {
      notifyOnIdle: false,
      minRunSeconds: "2.5",
      sound: "Glass",
      agentTool: true,
    },
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
