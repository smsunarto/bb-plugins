import { test } from "node:test";
import assert from "node:assert/strict";

import { notificationQueue } from "../delivery.ts";
import { createFakeContext } from "../fake-context.ts";
import { status } from "./status.ts";

test("status prints every line, aligned, for a listening window", async () => {
  const context = createFakeContext({
    settings: {
      notifyOnIdle: true,
      notifyOnFailed: false,
      includeChildThreads: false,
      includeHiddenThreads: true,
      minRunSeconds: "5",
      sound: "Glass",
      agentTool: true,
    },
  });
  const delivery = notificationQueue(context.bb);
  await delivery.queue.enqueue({
    title: "t",
    body: "b",
    threadId: null,
    silent: true,
    play: null,
  });
  await delivery.queue.enqueue({
    title: "t2",
    body: "b2",
    threadId: null,
    silent: true,
    play: null,
  });
  await delivery.queue.enqueue({
    title: "t3",
    body: "b3",
    threadId: null,
    silent: true,
    play: null,
  });
  const ac = new AbortController();
  const waiting = [
    delivery.waitForQueue(ac.signal, 60_000),
    delivery.waitForQueue(ac.signal, 60_000),
  ];
  const result = await status.invoke(context);
  ac.abort();
  await Promise.all(waiting);
  assert.deepEqual(result, {
    exitCode: 0,
    stdout:
      "window:     listening (2 polling)\n" +
      "held:       3\n" +
      "on idle:    true\n" +
      "on failed:  false\n" +
      "children:   false\n" +
      "hidden:     true\n" +
      "min run:    5s\n" +
      "sound:      Glass\n" +
      "agent tool: notify_user\n",
  });
});

test("status prints the closed-window and disabled-tool wording", async () => {
  const context = createFakeContext({
    listening: false,
    settings: {
      notifyOnIdle: true,
      notifyOnFailed: true,
      includeChildThreads: false,
      includeHiddenThreads: false,
      minRunSeconds: "0",
      sound: "off",
      agentTool: false,
    },
  });
  const result = await status.invoke(context);
  assert.deepEqual(result, {
    exitCode: 0,
    stdout:
      "window:     none open — notifications will wait\n" +
      "held:       0\n" +
      "on idle:    true\n" +
      "on failed:  true\n" +
      "children:   false\n" +
      "hidden:     false\n" +
      "min run:    0s\n" +
      "sound:      off\n" +
      "agent tool: disabled\n",
  });
});
