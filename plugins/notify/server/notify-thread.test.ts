import { test } from "node:test";
import assert from "node:assert/strict";

import { createFakeContext, queuedNotifications } from "./fake-context.ts";
import { notifyThread, type NotifiableThread } from "./notify-thread.ts";
import { bindRunTracker, createRunTracker } from "./run-tracker.ts";

function thread(overrides: Partial<NotifiableThread> = {}): NotifiableThread {
  return {
    id: "th_1",
    projectId: "p1",
    title: "Work",
    titleFallback: null,
    visibility: "visible",
    parentThreadId: null,
    ...overrides,
  };
}

test("notifyThread posts a finished thread", async () => {
  const ctx = createFakeContext({
    projectName: async () => "Acme",
  });
  await notifyThread(ctx.bb, thread(), "finished", "done");
  assert.deepEqual(await queuedNotifications(ctx), [
    { id: 1, title: "Work", body: "[Acme] done", threadId: "th_1", silent: true },
  ]);
});

test("notifyThread suppresses hidden threads", async () => {
  const ctx = createFakeContext();
  await notifyThread(ctx.bb, thread({ visibility: "hidden" }), "finished", "done");
  assert.deepEqual(await queuedNotifications(ctx), []);
});

test("notifyThread dedupes two events in the same window", async () => {
  const ctx = createFakeContext();
  bindRunTracker(
    ctx.bb,
    createRunTracker(() => 1_000),
  );
  await notifyThread(ctx.bb, thread(), "finished", "first");
  await notifyThread(ctx.bb, thread(), "failed", "second");
  assert.equal((await queuedNotifications(ctx)).length, 1);
});

test("notifyThread skips a run shorter than minRunSeconds", async () => {
  const ctx = createFakeContext({ settings: { minRunSeconds: "10" } });
  const tracker = createRunTracker(() => 1_000);
  bindRunTracker(ctx.bb, tracker);
  tracker.started("th_1");
  await notifyThread(ctx.bb, thread(), "finished", "too fast");
  assert.deepEqual(await queuedNotifications(ctx), []);
});
