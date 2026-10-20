import { afterEach, beforeEach, expect, test } from "bun:test";
import { installDom } from "@bb-kit/core/testing";
import type { PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";
import type { CloudSessionView } from "../shared/devin.ts";

installDom();
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { act, cleanup } = await import("@testing-library/react");
const { pluginQueryClient } = await import("@bb-kit/core/rpc/query");
beforeEach(() => pluginQueryClient.clear());
afterEach(cleanup);

type ThreadChange = Parameters<
  Extract<Parameters<PluginBrowserBbSdk["subscribe"]>[0], { event: "thread:changed" }>["callback"]
>[0];

const ACTIVE: CloudSessionView = {
  state: "active",
  sessionId: "devin-118de5960fdb40e0a6f497b55554e7ce",
  url: "https://app.devin.ai/sessions/118de5960fdb40e0a6f497b55554e7ce",
  attachCommand: "devin --cloud -r devin-118de5960fdb40e0a6f497b55554e7ce",
};

async function renderBanner(initial: CloudSessionView) {
  const app = await loadPluginApp(() => import("./app.tsx"));
  const registration = app.composerCustomizations.find((c) => c.id === "cloud-session")
    ?.banners?.[0];
  if (!registration) throw new Error("Missing Cloud banner");
  let view: CloudSessionView | Promise<CloudSessionView> = initial;
  const listeners = new Set<(event: ThreadChange) => void>();
  const slot = renderSlot(
    registration,
    {},
    {
      pluginId: "devin",
      composer: { scope: { kind: "thread", threadId: "thr_cloud" } },
      rpc: { cloudSession: () => view },
      sdk: {
        subscribe: (args) => {
          if (args.event !== "thread:changed") throw new Error("Unexpected subscription");
          const callback = args.callback as (event: ThreadChange) => void;
          listeners.add(callback);
          return () => {
            listeners.delete(callback);
          };
        },
      },
    },
  );
  const calls = () => slot.inspection.rpcCalls.filter((c) => c.method === "cloudSession").length;
  const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  await settle();
  return {
    slot,
    calls,
    settle,
    listeners,
    setView: (next: CloudSessionView | Promise<CloudSessionView>) => {
      view = next;
    },
    change: async (id: string, changes: ThreadChange["changes"], eventTypes?: string[]) => {
      await act(async () => {
        for (const listener of listeners)
          listener({
            type: "changed",
            entity: "thread",
            id,
            changes,
            ...(eventTypes === undefined ? {} : { metadata: { eventTypes: eventTypes as never } }),
          });
      });
      await settle();
    },
  };
}

test("a starting banner turns active when the thread's identity event arrives, with no timer", async () => {
  const banner = await renderBanner({ state: "starting" });
  expect(banner.slot.getByText("Starting")).toBeTruthy();
  expect(banner.calls()).toBe(1);

  // Streaming deltas and other threads cannot carry the session id.
  await banner.change("thr_cloud", ["events-appended"], ["item/agentMessage/delta"]);
  await banner.change("thr_other", ["events-appended", "status-changed"]);
  await banner.settle();
  expect(banner.calls()).toBe(1);

  banner.setView(ACTIVE);
  await banner.change("thr_cloud", ["events-appended"], ["thread/identity"]);
  expect(banner.calls()).toBe(2);
  expect(banner.slot.getByText("Active")).toBeTruthy();
  expect(banner.slot.getByText("Open in Devin")).toBeTruthy();
  // Active is final: nothing listens any more.
  expect(banner.listeners.size).toBe(0);
});

test("a thread that never runs on Cloud renders nothing and stops listening", async () => {
  const banner = await renderBanner({ state: "hidden" });
  expect(banner.slot.container.textContent).toBe("");
  expect(banner.listeners.size).toBe(0);
  expect(banner.calls()).toBe(1);
});

test("an unclaimed Devin thread shows its Cloud banner once its first turn starts", async () => {
  const banner = await renderBanner({ state: "unclaimed" });
  expect(banner.slot.container.textContent).toBe("");
  expect(banner.listeners.size).toBe(1);

  banner.setView({ state: "starting" });
  await banner.change("thr_cloud", ["status-changed"]);
  expect(banner.calls()).toBe(2);
  expect(banner.slot.getByText("Starting")).toBeTruthy();
});

test("an identity event heard while a read is out gets one more read", async () => {
  const banner = await renderBanner({ state: "starting" });
  let release!: () => void;
  banner.setView(
    new Promise<CloudSessionView>((resolve) => {
      release = () => resolve({ state: "starting" });
    }),
  );
  // The turn ends, and its read is still out when the bridge names the session.
  await banner.change("thr_cloud", ["status-changed"]);
  banner.setView(ACTIVE);
  await banner.change("thr_cloud", ["events-appended"], ["thread/identity"]);
  expect(banner.calls()).toBe(2);
  await act(async () => release());
  await banner.settle();
  expect(banner.calls()).toBe(3);
  expect(banner.slot.getByText("Active")).toBeTruthy();
});

test("a starting banner reconciles once realtime reconnects", async () => {
  const banner = await renderBanner({ state: "starting" });
  await act(() => banner.slot.behavior.setRealtimeConnectionState("reconnecting"));
  banner.setView(ACTIVE);
  await act(() => banner.slot.behavior.setRealtimeConnectionState("connected"));
  await banner.settle();
  expect(banner.calls()).toBe(2);
  expect(banner.slot.getByText("Active")).toBeTruthy();
});
