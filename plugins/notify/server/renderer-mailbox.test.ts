import { test } from "bun:test";
import assert from "node:assert/strict";

import { createRendererMailbox, type NotificationOffer } from "./renderer-mailbox.ts";

function notification(message: string): NotificationOffer {
  return {
    title: "Build",
    body: message,
    threadId: "th_1",
    silent: true,
    play: null,
  };
}

test("an offer without a renderer waiter is discarded", async () => {
  const mailbox = createRendererMailbox();
  assert.equal(await mailbox.offer(notification("finished")), "unavailable");
  mailbox.dispose();
});

test("a waiter receives one offer and its acknowledgement resolves the producer", async () => {
  const mailbox = createRendererMailbox({ createId: () => "delivery-1" });
  const waiting = mailbox.wait(new AbortController().signal);
  const offered = mailbox.offer(notification("finished"));
  assert.deepEqual(await waiting, {
    id: "delivery-1",
    notification: {
      title: "Build",
      body: "finished",
      threadId: "th_1",
      silent: true,
    },
  });
  assert.deepEqual(mailbox.acknowledge({ id: "delivery-1", outcome: "shown" }), {
    accepted: true,
    play: null,
  });
  assert.equal(await offered, "shown");
  assert.deepEqual(mailbox.acknowledge({ id: "delivery-1", outcome: "shown" }), {
    accepted: false,
    play: null,
  });
  mailbox.dispose();
});

test("the turnover buffer hands simultaneous offers to the returning renderer", async () => {
  let nextId = 0;
  const mailbox = createRendererMailbox({
    createId: () => `delivery-${++nextId}`,
    handoffWindowMs: 100,
  });
  const firstWait = mailbox.wait(new AbortController().signal);
  const first = mailbox.offer(notification("first"));
  assert.equal((await firstWait)?.id, "delivery-1");

  const second = mailbox.offer(notification("second"));
  const secondWait = mailbox.wait(new AbortController().signal);
  assert.equal((await secondWait)?.id, "delivery-2");
  mailbox.acknowledge({ id: "delivery-1", outcome: "shown" });
  mailbox.acknowledge({ id: "delivery-2", outcome: "shown" });
  assert.deepEqual(await Promise.all([first, second]), ["shown", "shown"]);
  mailbox.dispose();
});

test("the turnover buffer expires instead of replaying to a later renderer", async () => {
  const mailbox = createRendererMailbox({
    createId: () => "delivery-1",
    handoffWindowMs: 10,
  });
  const waiting = mailbox.wait(new AbortController().signal);
  const first = mailbox.offer(notification("first"));
  await waiting;
  const second = mailbox.offer(notification("second"));
  assert.equal(await second, "unavailable");

  const lateWait = mailbox.wait(AbortSignal.timeout(10));
  assert.equal(await lateWait, null);
  mailbox.acknowledge({ id: "delivery-1", outcome: "shown" });
  assert.equal(await first, "shown");
  mailbox.dispose();
});

test("abort, failed acknowledgement, timeout, and disposal settle pending work", async () => {
  const aborted = createRendererMailbox({ longPollMs: 1_000 });
  const controller = new AbortController();
  const waiting = aborted.wait(controller.signal);
  controller.abort();
  assert.equal(await waiting, null);
  aborted.dispose();

  const failed = createRendererMailbox({ createId: () => "failed" });
  const failedWait = failed.wait(new AbortController().signal);
  const failedOffer = failed.offer(notification("failed"));
  await failedWait;
  assert.deepEqual(failed.acknowledge({ id: "failed", outcome: "failed" }), {
    accepted: true,
    play: null,
  });
  assert.equal(await failedOffer, "failed");
  failed.dispose();

  const timedOut = createRendererMailbox({
    createId: () => "timeout",
    ackTimeoutMs: 5,
  });
  const timeoutWait = timedOut.wait(new AbortController().signal);
  const timeoutOffer = timedOut.offer(notification("timeout"));
  await timeoutWait;
  assert.equal(await timeoutOffer, "failed");
  timedOut.dispose();

  const disposed = createRendererMailbox({ createId: () => "disposed" });
  const disposeWait = disposed.wait(new AbortController().signal);
  const disposeOffer = disposed.offer(notification("disposed"));
  await disposeWait;
  disposed.dispose();
  assert.equal(await disposeOffer, "failed");
});

test("a shown acknowledgement returns the named sound once", async () => {
  const mailbox = createRendererMailbox({ createId: () => "sound" });
  const waiting = mailbox.wait(new AbortController().signal);
  const offered = mailbox.offer({ ...notification("sound"), play: "Glass" });
  await waiting;
  assert.deepEqual(mailbox.acknowledge({ id: "sound", outcome: "shown" }), {
    accepted: true,
    play: "Glass",
  });
  assert.equal(await offered, "shown");
  mailbox.dispose();
});

test("a suppressed acknowledgement resolves without releasing its named sound", async () => {
  const mailbox = createRendererMailbox({ createId: () => "suppressed" });
  const waiting = mailbox.wait(new AbortController().signal);
  const offered = mailbox.offer({ ...notification("suppressed"), play: "Glass" });
  await waiting;
  assert.deepEqual(mailbox.acknowledge({ id: "suppressed", outcome: "suppressed" }), {
    accepted: true,
    play: null,
  });
  assert.equal(await offered, "suppressed");
  mailbox.dispose();
});
