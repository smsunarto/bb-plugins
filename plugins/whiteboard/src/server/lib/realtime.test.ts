import { randomUUID } from "node:crypto";
import { DatabaseSync as NodeDatabaseSync } from "node:sqlite";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createRealtime, publishEngineChanges } from "./realtime.ts";
import { ReviewStore } from "./vendor/review/src/review-api/store.ts";

vi.mock("./sqlite.ts", () => ({ DatabaseSync: NodeDatabaseSync }));

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function host() {
  const { bb, harness } = createFakePluginHost({ pluginId: "whiteboard" });
  return { realtime: createRealtime(bb), signals: harness.inspection.realtimeSignals, harness };
}

describe("createRealtime", () => {
  test("coalesces changes per key over 50 ms and publishes the latest payload", () => {
    const { realtime, signals } = host();

    realtime.changed({ kind: "review", reviewId: "r1", version: 1 });
    realtime.changed({ kind: "review", reviewId: "r1", version: 2 });
    realtime.changed({ kind: "review", reviewId: "r2", version: 7 });
    realtime.changed({ kind: "catalog" });
    realtime.changed({ kind: "catalog" });
    realtime.changed({ kind: "activity", reviewId: "r1" });
    vi.advanceTimersByTime(49);
    expect(signals).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(signals).toEqual([
      { channel: "whiteboard:changed", payload: { kind: "review", reviewId: "r1", version: 2 } },
      { channel: "whiteboard:changed", payload: { kind: "review", reviewId: "r2", version: 7 } },
      { channel: "whiteboard:changed", payload: { kind: "catalog" } },
      { channel: "whiteboard:changed", payload: { kind: "activity", reviewId: "r1" } },
    ]);

    realtime.changed({ kind: "review", reviewId: "r1", version: 3 });
    vi.advanceTimersByTime(50);
    expect(signals.at(-1)).toEqual({
      channel: "whiteboard:changed",
      payload: { kind: "review", reviewId: "r1", version: 3 },
    });
    expect(signals).toHaveLength(5);
  });

  test("open and settings publish at once", () => {
    const { realtime, signals } = host();

    realtime.open({ threadId: "t1", sessionId: "s1", title: "Plan", nonce: "n1" });
    realtime.settings({ scratchpadEnabled: true, softwareMapEnabled: false });

    expect(signals).toEqual([
      {
        channel: "whiteboard:open",
        payload: { threadId: "t1", sessionId: "s1", title: "Plan", nonce: "n1" },
      },
      {
        channel: "whiteboard:settings",
        payload: { scratchpadEnabled: true, softwareMapEnabled: false },
      },
    ]);
  });

  test("dispose drops pending changes and ignores later calls", async () => {
    const { realtime, signals, harness } = host();

    realtime.changed({ kind: "coverage" });
    expect(vi.getTimerCount()).toBe(1);
    realtime.dispose();
    // The pending coalescing timer is cleared, not left to fire into a stale handle.
    expect(vi.getTimerCount()).toBe(0);
    realtime.dispose();
    await harness.lifecycle.dispose();
    realtime.changed({ kind: "catalog" });
    realtime.open({ threadId: "t1", sessionId: "s1", title: "Plan", nonce: "n1" });
    vi.advanceTimersByTime(1_000);

    expect(signals).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("publishEngineChanges", () => {
  test("maps the upstream store's events and stops on unsubscribe", async () => {
    vi.useRealTimers();
    const store = new ReviewStore(":memory:", {
      validatePins: async () => {},
      validateSource: async () => {},
      validateResource: async () => {},
    });
    const { bb, harness } = createFakePluginHost({ pluginId: "whiteboard" });
    const realtime = createRealtime(bb);
    let coverage: (() => void) | undefined;
    const data = {
      subscribeCoverage(listener: () => void) {
        coverage = listener;
        return () => {
          coverage = undefined;
        };
      },
    };
    const stop = publishEngineChanges(realtime, { store, data });
    const flush = () => new Promise((resolve) => setTimeout(resolve, 60));

    const created = await store.execute({
      commandId: randomUUID(),
      operation: {
        type: "create",
        title: "Plan",
        pins: { repositoryId: "repo", base: "a", head: "b" },
      },
    });
    const leaseId = randomUUID();
    store.activity.update(created.reviewId, { action: "begin", leaseId });
    coverage?.();
    await flush();

    expect(harness.inspection.realtimeSignals).toEqual([
      {
        channel: "whiteboard:changed",
        payload: { kind: "review", reviewId: created.reviewId, version: 0 },
      },
      { channel: "whiteboard:changed", payload: { kind: "catalog" } },
      { channel: "whiteboard:changed", payload: { kind: "activity", reviewId: created.reviewId } },
      { channel: "whiteboard:changed", payload: { kind: "coverage" } },
    ]);

    stop();
    stop();
    expect(coverage).toBeUndefined();
    await store.execute({
      commandId: randomUUID(),
      leaseId,
      operation: { type: "rename", reviewId: created.reviewId, title: "Renamed" },
    });
    await flush();
    expect(harness.inspection.realtimeSignals).toHaveLength(4);
    realtime.dispose();
    await store.close();
  });
});
