// The Oracle card reads server state that only changes when the thread does.
// These tests pin that it refreshes on that thread's realtime changes instead
// of a timer, and that settled answers are kept across remounts instead of
// asked for again. The Orb banner reads bb's extension state directly.
import assert from "node:assert/strict";
import { afterEach, test } from "bun:test";
import "./helpers/plugin-app-runtime.ts";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { act, cleanup } from "@testing-library/react";
import * as appModule from "../app.tsx";
import type { OracleReport } from "../src/oracle-directive.ts";
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

/** The Orb banner on `threadId`, with bb reporting `link` as the thread's
 *  `thread-link` extension state (undefined: none published). */
function renderOrb(threadId: string, link?: unknown) {
  return renderSlot(orbBanner!, {}, {
    composer: { scope: { kind: "thread", threadId } },
    threadExtensionStates: link === undefined ? {} : { [threadId]: { "thread-link": link } },
  } as never);
}

test("the Orb banner reads the thread's published link, with no request", async () => {
  const unlinked = renderOrb("thr_orb");
  assert.equal(unlinked.container.textContent, "");
  unlinked.unmount();

  const starting = renderOrb("thr_orb", {
    ampThreadId: null,
    executionTarget: "orb",
    syncCommand: null,
  });
  assert.ok(starting.getByText("Starting"));
  starting.unmount();

  const active = renderOrb("thr_orb", {
    ampThreadId: "T-abc",
    executionTarget: "orb",
    syncCommand: "amp sync T-abc",
  });
  assert.ok(active.getByText("Active"));
  assert.equal(active.inspection.rpcCalls.length, 0);
});

test("a local run, or a link that fails the schema, shows no banner", async () => {
  const local = renderOrb("thr_local", {
    ampThreadId: "T-abc",
    executionTarget: "local",
    syncCommand: null,
  });
  assert.equal(local.container.textContent, "");
  local.unmount();

  const drifted = renderOrb("thr_drift", { executionTarget: "cloud" });
  assert.equal(drifted.container.textContent, "");
});

test("copying the sync command goes through bb's clipboard writer", async () => {
  const slot = renderOrb("thr_copy", {
    ampThreadId: "T-copy",
    executionTarget: "orb",
    syncCommand: "amp sync T-copy",
  });
  await act(async () => {
    slot.getByLabelText("Copy Amp sync command").click();
    await settle();
  });
  assert.deepEqual(slot.inspection.experimental_clipboardWrites, [{ text: "amp sync T-copy" }]);
  assert.ok(slot.getByText("Copied"));
});
