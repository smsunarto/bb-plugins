import { mock, test } from "bun:test";
import assert from "node:assert/strict";

import { deliver, type NotificationOfferer } from "./delivery.ts";
import { createFakeContext } from "./fake-context.ts";

test("deliver formats one renderer notification", async () => {
  const ctx = createFakeContext({ settings: { sound: "Glass" } });
  const offer = mock<NotificationOfferer>(async () => "shown");
  const sent = await deliver(
    ctx.bb,
    {
      project: "Acme",
      heading: "Build",
      message: "finished",
      threadId: "th_1",
    },
    offer,
  );

  assert.equal(sent, true);
  assert.deepEqual(offer.mock.calls, [
    [
      {
        title: "Build",
        body: "[Acme] finished",
        threadId: "th_1",
        silent: true,
        play: "Glass",
      },
    ],
  ]);
});

test("deliver reports unavailable and failed renderer outcomes", async () => {
  const ctx = createFakeContext();
  const input = {
    project: null,
    heading: "bb",
    message: "hello",
    threadId: null,
  };
  assert.equal(await deliver(ctx.bb, input, async () => "unavailable"), false);
  assert.equal(await deliver(ctx.bb, input, async () => "failed"), false);
});
