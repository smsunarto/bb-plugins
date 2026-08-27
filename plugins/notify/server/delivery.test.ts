import { mock, test } from "bun:test";
import assert from "node:assert/strict";

import { deliver, type NotificationOfferer } from "./delivery.ts";
import { createFakeContext } from "./fake-context.ts";

test("deliver formats one renderer notification", async () => {
  const ctx = createFakeContext({ settings: { sound: "Glass" } });
  const offer = mock<NotificationOfferer>(async () => "shown");
  const outcome = await deliver(
    ctx.bb,
    {
      project: "Acme",
      heading: "Build",
      message: "finished",
      threadId: "th_1",
    },
    offer,
  );

  assert.equal(outcome, "shown");
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

test("deliver preserves suppressed, unavailable, and failed renderer outcomes", async () => {
  const ctx = createFakeContext();
  const input = {
    project: null,
    heading: "bb",
    message: "hello",
    threadId: null,
  };
  assert.equal(await deliver(ctx.bb, input, async () => "suppressed"), "suppressed");
  assert.equal(await deliver(ctx.bb, input, async () => "unavailable"), "unavailable");
  assert.equal(await deliver(ctx.bb, input, async () => "failed"), "failed");
  assert.equal(
    await deliver(ctx.bb, input, async () => {
      throw new Error("renderer disconnected");
    }),
    "failed",
  );
});
