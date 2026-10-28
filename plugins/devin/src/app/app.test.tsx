import { afterEach, beforeEach, expect, test } from "bun:test";
import { installDom } from "@bb-plugins/testing";
import type { PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";
import type { CloudSessionView } from "../shared/devin.ts";

installDom();
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { useComposer } = await import("@get-bb/plugin-sdk/app");
const { act, cleanup, fireEvent } = await import("@testing-library/react");
const { queryClient } = await import("./query.ts");
beforeEach(() => queryClient.clear());
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

async function cloudToggleBanner() {
  const app = await loadPluginApp(() => import("./app.tsx"));
  const customization = app.composerCustomizations.find((c) => c.id === "cloud-toggle");
  // A hidden action would still hold one of bb's three inline action slots.
  expect(customization?.actions).toBeUndefined();
  const banner = customization?.banners?.[0];
  if (!banner) throw new Error("Missing Cloud toggle");
  return banner;
}

const TOGGLE_RPC = {
  cloudIntent: () => ({ armed: false }),
  setCloudIntent: (input: unknown) => input,
};

test("the Cloud toggle shows only while the composer's selected provider is Devin", async () => {
  const toggle = await cloudToggleBanner();
  const cases = [
    { selection: { providerId: "devin", model: "swe-1.6" }, visible: true },
    { selection: { providerId: "claude-code" }, visible: false },
    // No pickers resolved yet: nothing says Devin is selected.
    { selection: undefined, visible: false },
  ];
  for (const { selection, visible } of cases) {
    const slot = renderSlot(
      toggle,
      {},
      {
        pluginId: "devin",
        composer: {
          scope: { kind: "new-thread", projectId: "prj_1" },
          ...(selection === undefined ? {} : { selection }),
        },
        rpc: TOGGLE_RPC,
      },
    );
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(slot.queryByRole("button", { name: /Cloud/ }) !== null).toBe(visible);
    slot.unmount();
  }
});

test("the Cloud toggle follows the provider picker as the user switches", async () => {
  const toggle = await cloudToggleBanner();
  const Toggle = toggle.component;
  function PickerAndToggle() {
    const composer = useComposer();
    return (
      <>
        <button onClick={() => void composer.setSelection({ providerId: "devin" })} type="button">
          Pick Devin
        </button>
        <button onClick={() => void composer.setSelection({ providerId: "codex" })} type="button">
          Pick Codex
        </button>
        <Toggle />
      </>
    );
  }
  const slot = renderSlot(
    { component: PickerAndToggle },
    {},
    {
      pluginId: "devin",
      composer: {
        scope: { kind: "new-thread", projectId: "prj_1" },
        selection: { providerId: "codex" },
      },
      rpc: TOGGLE_RPC,
    },
  );
  expect(slot.queryByTitle("Run this thread on a Devin Cloud VM")).toBeNull();
  await act(async () => fireEvent.click(slot.getByText("Pick Devin")));
  expect(slot.getByTitle("Run this thread on a Devin Cloud VM")).toBeTruthy();
  await act(async () => fireEvent.click(slot.getByText("Pick Codex")));
  expect(slot.queryByTitle("Run this thread on a Devin Cloud VM")).toBeNull();
});

test("copying the attach command goes through bb's clipboard writer", async () => {
  const banner = await renderBanner(ACTIVE);
  await act(async () => fireEvent.click(banner.slot.getByLabelText("Copy Devin attach command")));
  expect(banner.slot.inspection.experimental_clipboardWrites).toEqual([
    { text: ACTIVE.attachCommand },
  ]);
  expect(banner.slot.getByText("Copied")).toBeTruthy();
});

test("a submit from the thread composer re-reads a live Cloud session", async () => {
  const app = await loadPluginApp(() => import("./app.tsx"));
  const banner = app.composerCustomizations.find((c) => c.id === "cloud-session")?.banners?.[0];
  if (!banner) throw new Error("Missing Cloud banner");
  const Banner = banner.component;
  function BannerAndEnter() {
    const composer = useComposer();
    return (
      <>
        <Banner />
        <button onClick={() => void composer.submit()} type="button">
          Enter
        </button>
      </>
    );
  }
  const slot = renderSlot(
    { component: BannerAndEnter },
    {},
    {
      pluginId: "devin",
      composer: { scope: { kind: "thread", threadId: "thr_cloud" }, text: "go" },
      rpc: { cloudSession: () => ({ state: "unclaimed" }) },
      sdk: { subscribe: () => () => {} },
    },
  );
  const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  await settle();
  const reads = () => slot.inspection.rpcCalls.filter((c) => c.method === "cloudSession").length;
  expect(reads()).toBe(1);
  await act(async () => fireEvent.click(slot.getByText("Enter")));
  await settle();
  expect(slot.inspection.composer.submits).toHaveLength(1);
  expect(reads()).toBe(2);
});
