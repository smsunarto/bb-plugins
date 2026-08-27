import { test } from "node:test";
import assert from "node:assert/strict";

import { notificationQueue } from "./delivery.ts";
import { createFakeContext } from "./fake-context.ts";

test("enqueue wakes a held nextBatch without waiting out the poll", async () => {
  const ctx = createFakeContext({ listening: false });
  const delivery = notificationQueue(ctx.bb);
  const ac = new AbortController();
  const pending = delivery.nextBatch(ac.signal);
  while (delivery.pollingCount() === 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const started = Date.now();
  await delivery.enqueue({
    title: "t",
    body: "b",
    threadId: null,
    silent: true,
    play: null,
  });
  const batch = await pending;
  assert.equal(batch.notifications.length, 1);
  assert.equal(batch.notifications[0]?.body, "b");
  assert.ok(Date.now() - started < 1_000);
});
