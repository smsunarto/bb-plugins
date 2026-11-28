import { expect, test } from "bun:test";
import {
  backoffDelay,
  createRefreshScheduler,
  type RefreshResult,
} from "../src/app/rpiv-todo/refresh-scheduler.ts";

/** A manual clock with timers, so 30s of polling runs instantly. */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => now,
    setTimer: (callback: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimer: (handle: unknown) => {
      timers.delete(handle as number);
    },
    get pending() {
      return timers.size;
    },
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        let due: [number, { at: number; callback: () => void }] | undefined;
        for (const entry of timers)
          if (entry[1].at <= end && (!due || entry[1].at < due[1].at)) due = entry;
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
        // Let the async load settle before the next timer.
        for (let i = 0; i < 10; i++) await Promise.resolve();
      }
      now = end;
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

test("an empty running thread loads once and never polls", async () => {
  const clock = fakeClock();
  let calls = 0;
  const scheduler = createRefreshScheduler({
    ...clock,
    load: async () => {
      calls += 1;
      // Banner rule: keep polling only with visible tasks or paging history.
      return { ok: true, keepPolling: false };
    },
  });
  scheduler.request();
  await flush();
  await clock.advance(30_000);
  expect(calls).toBe(1);
  expect(clock.pending).toBe(0);
  scheduler.dispose();
});

test("visible tasks on a running thread poll every 1.2s", async () => {
  const clock = fakeClock();
  let calls = 0;
  const scheduler = createRefreshScheduler({
    ...clock,
    load: async () => {
      calls += 1;
      return { ok: true, keepPolling: true };
    },
  });
  scheduler.request();
  await flush();
  await clock.advance(6_000);
  expect(calls).toBe(6);
  scheduler.dispose();
  await clock.advance(6_000);
  expect(calls).toBe(6);
});

test("failures back off exponentially from 1.2s to 30s and reset on success", async () => {
  expect([1, 2, 3, 4, 5, 6, 7].map((n) => backoffDelay(n, 1200, 30_000))).toEqual([
    1200, 2400, 4800, 9600, 19_200, 30_000, 30_000,
  ]);
  const clock = fakeClock();
  const at: number[] = [];
  let fail = true;
  const scheduler = createRefreshScheduler({
    ...clock,
    load: async (): Promise<RefreshResult> => {
      at.push(clock.now());
      return fail ? { ok: false, keepRetrying: true } : { ok: true, keepPolling: false };
    },
  });
  scheduler.request();
  await flush();
  await clock.advance(30_000);
  // 0, +1.2, +2.4, +4.8, +9.6 => 0, 1200, 3600, 8400, 18000 (next at 37200)
  expect(at).toEqual([0, 1200, 3600, 8400, 18_000]);
  fail = false;
  await clock.advance(20_000);
  expect(at).toHaveLength(6);
  await clock.advance(60_000);
  expect(at).toHaveLength(6);
  scheduler.dispose();
});

test("requests during an in-flight load coalesce into exactly one follow-up", async () => {
  const clock = fakeClock();
  let calls = 0;
  let release: () => void = () => {};
  const scheduler = createRefreshScheduler({
    ...clock,
    load: async () => {
      calls += 1;
      if (calls === 1) await new Promise<void>((resolve) => (release = resolve));
      return { ok: true, keepPolling: false };
    },
  });
  scheduler.request();
  await flush();
  for (let i = 0; i < 20; i++) scheduler.request();
  expect(calls).toBe(1);
  release();
  await flush();
  expect(calls).toBe(2);
  await clock.advance(10_000);
  expect(calls).toBe(2);
  scheduler.dispose();
});

test("throttled requests run at most once per interval after the last load", async () => {
  const clock = fakeClock();
  let calls = 0;
  const scheduler = createRefreshScheduler({
    ...clock,
    load: async () => {
      calls += 1;
      return { ok: true, keepPolling: false };
    },
  });
  scheduler.request();
  await flush();
  for (let i = 0; i < 10; i++) scheduler.request({ throttle: true });
  await flush();
  expect(calls).toBe(1);
  await clock.advance(1_200);
  expect(calls).toBe(2);
  await clock.advance(5_000);
  expect(calls).toBe(2);
  scheduler.request({ throttle: true });
  await flush();
  expect(calls).toBe(3);
  scheduler.dispose();
});
