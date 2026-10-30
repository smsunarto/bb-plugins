import { randomUUID } from "node:crypto";
import { DatabaseSync as NodeDatabaseSync } from "node:sqlite";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { INVALIDATE_COALESCE_MS, createRealtime, publishEngineChanges } from "./realtime.ts";
import { ReviewStore } from "./review/store.ts";

vi.mock("./sqlite.ts", () => ({ DatabaseSync: NodeDatabaseSync }));

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function host() {
  const { bb, harness } = createFakePluginHost({ pluginId: "whiteboard" });
  return { realtime: createRealtime(bb), inspection: harness.inspection, harness };
}

describe("createRealtime", () => {
  test("coalesces invalidations over 50 ms into one call carrying every tag once", () => {
    const { realtime, inspection } = host();

    realtime.invalidate(["session:r1"]);
    realtime.invalidate(["session:r1"]);
    realtime.invalidate(["session:r2"]);
    realtime.invalidate(["catalog", "live-session"]);
    vi.advanceTimersByTime(INVALIDATE_COALESCE_MS - 1);
    expect(inspection.experimental_rpcInvalidations).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(inspection.experimental_rpcInvalidations).toEqual([
      ["session:r1", "session:r2", "catalog", "live-session"],
    ]);

    realtime.invalidate(["session:r1"]);
    vi.advanceTimersByTime(INVALIDATE_COALESCE_MS);
    expect(inspection.experimental_rpcInvalidations).toEqual([
      ["session:r1", "session:r2", "catalog", "live-session"],
      ["session:r1"],
    ]);
    // Live data never travels on a realtime channel.
    expect(inspection.realtimeSignals).toEqual([]);
  });

  test("open publishes at once", () => {
    const { realtime, inspection } = host();

    realtime.open({ threadId: "t1", sessionId: "s1", title: "Plan", at: 1 });

    expect(inspection.realtimeSignals).toEqual([
      {
        channel: "whiteboard:open",
        payload: { threadId: "t1", sessionId: "s1", title: "Plan", at: 1 },
      },
    ]);
  });

  test("dispose drops pending invalidations and ignores later calls", async () => {
    const { realtime, inspection, harness } = host();

    realtime.invalidate(["catalog"]);
    expect(vi.getTimerCount()).toBe(1);
    realtime.dispose();
    // The pending coalescing timer is cleared, not left to fire into a stale handle.
    expect(vi.getTimerCount()).toBe(0);
    realtime.dispose();
    await harness.lifecycle.dispose();
    realtime.invalidate(["catalog"]);
    realtime.open({ threadId: "t1", sessionId: "s1", title: "Plan", at: 1 });
    vi.advanceTimersByTime(1_000);

    expect(inspection.experimental_rpcInvalidations).toEqual([]);
    expect(inspection.realtimeSignals).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("publishEngineChanges", () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, INVALIDATE_COALESCE_MS + 10));

  async function start() {
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
    const created = await store.execute({
      commandId: randomUUID(),
      operation: {
        type: "create",
        source: "pins",
        title: "Plan",
        pins: { repositoryId: "repo", base: "a", head: "b" },
      },
    });
    await flush();
    const invalidations = harness.inspection.experimental_rpcInvalidations;
    invalidations.length = 0;
    return {
      store,
      realtime,
      stop,
      invalidations,
      reviewId: created.reviewId,
      coverage: () => coverage?.(),
      subscribed: () => coverage !== undefined,
    };
  }

  test.each([
    {
      change: "a document write",
      act: async ({ store, reviewId }: Awaited<ReturnType<typeof start>>) => {
        await store.execute({
          commandId: randomUUID(),
          operation: { type: "rename", reviewId, title: "Renamed" },
        });
      },
      // A rename also changes the catalog row.
      tags: (id: string) => [`session:${id}`, "catalog"],
    },
    {
      change: "an activity lease",
      act: async ({ store, reviewId }: Awaited<ReturnType<typeof start>>) => {
        store.activity.update(reviewId, { action: "begin", leaseId: randomUUID() });
      },
      tags: (id: string) => [`session:${id}`],
    },
    {
      change: "attention, a catalog-only change",
      act: async ({ store, reviewId }: Awaited<ReturnType<typeof start>>) => {
        await store.execute({
          commandId: randomUUID(),
          operation: { type: "attention", reviewId, action: "dismiss" },
        });
      },
      tags: () => ["catalog"],
    },
    {
      change: "new coverage",
      act: async ({ coverage }: Awaited<ReturnType<typeof start>>) => coverage(),
      tags: () => ["catalog", "live-session"],
    },
  ])("$change invalidates the live reads it changes", async ({ act, tags }) => {
    const engine = await start();

    await act(engine);
    await flush();

    expect(engine.invalidations).toEqual([tags(engine.reviewId)]);
    engine.realtime.dispose();
    engine.stop();
    await engine.store.close();
  });

  test("stops on unsubscribe", async () => {
    const engine = await start();

    engine.stop();
    engine.stop();
    expect(engine.subscribed()).toBe(false);
    await engine.store.execute({
      commandId: randomUUID(),
      operation: { type: "rename", reviewId: engine.reviewId, title: "Renamed" },
    });
    await flush();

    expect(engine.invalidations).toEqual([]);
    engine.realtime.dispose();
    await engine.store.close();
  });
});
