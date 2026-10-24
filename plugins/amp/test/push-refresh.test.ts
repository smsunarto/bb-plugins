// The Oracle card and the Orb banner read server state that only changes
// when the thread does. These tests pin that they refresh on that thread's
// realtime changes instead of a timer, and that settled answers are kept
// across remounts instead of asked for again.
import assert from "node:assert/strict";
import { afterEach, test } from "bun:test";
import "./helpers/plugin-app-runtime.ts";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { act, cleanup } from "@testing-library/react";
import * as appModule from "../app.tsx";
import type { OracleReport } from "../src/oracle-directive.ts";
import type { OrbUsageView } from "../src/orb-usage.ts";
import type { ThreadChange } from "../src/thread-changes.ts";

const app = await loadPluginApp(appModule);

afterEach(cleanup);

const oracleDirective = app.messageDirectives[0];
const orbBanner = app.composerCustomizations.find((entry) => entry.id === "orb-usage-banner")
  ?.banners?.[0];
assert.ok(oracleDirective, "the Oracle directive is registered");
assert.ok(orbBanner, "the Orb banner is registered");

function report(id: string, status: OracleReport["status"]): OracleReport {
  return {
    id,
    request: "Why does the cache miss?",
    response: status === "running" ? "" : "The key includes the timestamp.",
    status,
    trace: [],
    createdAt: "2026-10-09T00:00:00.000Z",
  };
}

/** A fake realtime channel: `change` delivers one `thread:changed`. */
function realtime() {
  const listeners = new Set<(event: ThreadChange) => void>();
  return {
    listeners,
    subscribe: ((args: { event: string; callback: (event: ThreadChange) => void }) => {
      assert.equal(args.event, "thread:changed");
      listeners.add(args.callback);
      return () => {
        listeners.delete(args.callback);
      };
    }) as never,
    change: (id: string, changes: ThreadChange["changes"], eventTypes?: string[]) =>
      act(async () => {
        for (const listener of listeners) {
          listener({
            type: "changed",
            entity: "thread",
            id,
            changes,
            ...(eventTypes === undefined ? {} : { metadata: { eventTypes: eventTypes as never } }),
          });
        }
        await settle();
      }),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function renderOracle(
  reportId: string,
  getOracleReport: () => { report: OracleReport | null; error: string | null },
  channel = realtime(),
) {
  const slot = renderSlot(
    oracleDirective!,
    {
      attributes: { reportId },
      source: `::amp-oracle{reportId="${reportId}"}`,
      message: { threadId: "thr_amp" },
      openWorkspaceFile: null,
    } as never,
    { rpc: { getOracleReport }, sdk: { subscribe: channel.subscribe } } as never,
  );
  return { slot, channel };
}

const oracleCalls = (slot: ReturnType<typeof renderSlot>) =>
  slot.inspection.rpcCalls.filter((call) => call.method === "getOracleReport").length;

test("a finished Oracle report renders on remount without asking the host again", async () => {
  const id = "0b7c3d1e-2f4a-4b5c-8d6e-7f8091a2b3c4";
  const first = renderOracle(id, () => ({ report: report(id, "completed"), error: null }));
  await act(settle);
  assert.ok(first.slot.getByText("The key includes the timestamp."));
  assert.equal(oracleCalls(first.slot), 1);
  assert.equal(first.channel.listeners.size, 0, "a finished report listens to nothing");
  first.slot.unmount();

  const again = renderOracle(id, () => {
    throw new Error("a cached report must not be fetched");
  });
  assert.ok(again.slot.getByText("The key includes the timestamp."));
  assert.equal(oracleCalls(again.slot), 0);
});

test("a running Oracle report refreshes when its thread closes an item, not on a timer", async () => {
  const id = "1c8d4e2f-3a5b-4c6d-9e7f-8091a2b3c4d5";
  let current = report(id, "running");
  const { slot, channel } = renderOracle(id, () => ({ report: current, error: null }));
  await act(settle);
  assert.ok(slot.getByText("Running…"));
  assert.equal(oracleCalls(slot), 1);

  // Waiting out the old 750 ms poll asks for nothing.
  await act(() => new Promise((resolve) => setTimeout(resolve, 900)));
  // Streaming deltas and other threads say nothing about the report.
  await channel.change("thr_amp", ["events-appended"], ["item/agentMessage/delta"]);
  await channel.change("thr_other", ["events-appended", "status-changed"]);
  assert.equal(oracleCalls(slot), 1);

  current = report(id, "completed");
  await channel.change("thr_amp", ["events-appended"], ["item/completed"]);
  assert.equal(oracleCalls(slot), 2);
  assert.ok(slot.getByText("The key includes the timestamp."));
  assert.equal(channel.listeners.size, 0);
});

test("an Oracle report that finishes while its first read is answering still shows finished", async () => {
  const id = "2d9e5f3a-4b6c-4d7e-8f80-91a2b3c4d5e6";
  let release = () => {};
  let calls = 0;
  const { slot, channel } = renderOracle(id, () => {
    calls += 1;
    // The host read "running"; the answer is still on its way.
    if (calls === 1) {
      return new Promise((resolve) => {
        release = () => resolve({ report: report(id, "running"), error: null });
      }) as never;
    }
    return { report: report(id, "completed"), error: null };
  });
  await act(settle);
  // The report finishes, and its thread says so, before that answer lands.
  await channel.change("thr_amp", ["events-appended"], ["item/completed"]);
  await act(async () => {
    release();
    await settle();
  });
  assert.ok(slot.getByText("The key includes the timestamp."));
  assert.equal(channel.listeners.size, 0);
});

function renderOrb(
  threadId: string,
  getOrbUsage: () => OrbUsageView | Promise<OrbUsageView>,
  channel = realtime(),
) {
  const slot = renderSlot(orbBanner!, {}, {
    composer: { scope: { kind: "thread", threadId } },
    rpc: { getOrbUsage },
    sdk: { subscribe: channel.subscribe },
  } as never);
  return { slot, channel };
}

const orbCalls = (slot: ReturnType<typeof renderSlot>) =>
  slot.inspection.rpcCalls.filter((call) => call.method === "getOrbUsage").length;

test("the Orb banner appears when the thread publishes its link, with no timer", async () => {
  let view: OrbUsageView = { state: "unlinked" };
  const { slot, channel } = renderOrb("thr_orb", () => view);
  await act(settle);
  assert.equal(slot.container.textContent, "");
  assert.equal(orbCalls(slot), 1);

  await act(() => new Promise((resolve) => setTimeout(resolve, 900)));
  await channel.change("thr_orb", ["events-appended"], ["item/agentMessage/delta"]);
  assert.equal(orbCalls(slot), 1);

  view = { state: "starting" };
  await channel.change("thr_orb", ["events-appended"], ["thread/extensionState/updated"]);
  assert.ok(slot.getByText("Starting"));

  view = { state: "active", ampThreadId: "T-abc", syncCommand: "amp sync T-abc" };
  await channel.change("thr_orb", ["events-appended"], ["thread/extensionState/updated"]);
  assert.ok(slot.getByText("Active"));
  assert.equal(orbCalls(slot), 3);
  assert.equal(channel.listeners.size, 0, "an active banner is settled");
});

test("another provider's thread is asked once and then left alone", async () => {
  const channel = realtime();
  const first = renderOrb("thr_claude", () => ({ state: "hidden" }), channel);
  await act(settle);
  assert.equal(orbCalls(first.slot), 1);
  assert.equal(channel.listeners.size, 0);
  first.slot.unmount();

  const again = renderOrb("thr_claude", () => {
    throw new Error("a settled thread must not be asked again");
  });
  await act(settle);
  assert.equal(orbCalls(again.slot), 0);
});

test("two panes on one thread share one request per change", async () => {
  let resolve!: (view: OrbUsageView) => void;
  const pending = new Promise<OrbUsageView>((done) => {
    resolve = done;
  });
  let calls = 0;
  const handler = () => {
    calls += 1;
    return pending;
  };
  renderOrb("thr_split", handler);
  renderOrb("thr_split", handler);
  await act(async () => {
    resolve({ state: "starting" });
    await settle();
  });
  assert.equal(calls, 1);
});

test("a link published while a read is out gets one more read", async () => {
  let release!: () => void;
  const first = new Promise<OrbUsageView>((done) => {
    release = () => done({ state: "unlinked" });
  });
  let view: OrbUsageView | Promise<OrbUsageView> = first;
  const { slot, channel } = renderOrb("thr_race", () => view);
  view = { state: "active", ampThreadId: "T-race", syncCommand: "amp sync T-race" };
  // Two panes' worth of the same change, heard before the first answer lands.
  await channel.change("thr_race", ["events-appended"], ["thread/extensionState/updated"]);
  await channel.change("thr_race", ["events-appended"], ["thread/extensionState/updated"]);
  assert.equal(orbCalls(slot), 1);
  await act(async () => {
    release();
    await settle();
  });
  assert.equal(orbCalls(slot), 2);
  assert.ok(slot.getByText("Active"));
});

test("copying the sync command goes through bb's clipboard writer", async () => {
  const { slot } = renderOrb("thr_copy", () => ({
    state: "active",
    ampThreadId: "T-copy",
    syncCommand: "amp sync T-copy",
  }));
  await act(settle);
  await act(async () => {
    slot.getByLabelText("Copy Amp sync command").click();
    await settle();
  });
  assert.deepEqual(slot.inspection.experimental_clipboardWrites, [{ text: "amp sync T-copy" }]);
  assert.ok(slot.getByText("Copied"));
});
