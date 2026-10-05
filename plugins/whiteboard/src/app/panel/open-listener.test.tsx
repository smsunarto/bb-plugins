// @vitest-environment jsdom
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, expect, test, vi } from "vitest";
import type { PendingOpen } from "../../shared/contracts/api-tunnel.ts";
import { OpenListener } from "./open-listener.tsx";

const registration = { component: OpenListener };
let mounted: ReturnType<typeof renderSlot>[] = [];

/** Opens' `at`, increasing across tests: the listener's order is module-level, as in a window. */
let clock = 1_000;
const open = (sessionId = "s1", title = "Plan"): PendingOpen => ({ sessionId, title, at: ++clock });

/**
 * The server's waiting open, shared by the panes given the same object. A
 * claim reads it; an `after` at or past it forgets it (session-tabs.ts).
 */
type Server = {
  waiting: PendingOpen | null;
  /** The thread `waiting` belongs to. Unset, every thread sees it. */
  thread?: string;
};

/** A pane showing `threadId`. */
function pane(
  threadId: string,
  {
    compact = false,
    server = { waiting: null } as Server,
    connection = "connected" as "connected" | "reconnecting",
    /** Delays a claim's answer: return a promise. */
    answer = (waiting: PendingOpen | null): PendingOpen | null | Promise<PendingOpen | null> =>
      waiting,
  } = {},
) {
  const slot = renderSlot(
    registration,
    { threadId, projectId: "p1", isCompactViewport: compact },
    {
      pluginId: "whiteboard",
      context: { threadId, projectId: "p1" },
      realtimeConnectionState: connection,
      rpc: {
        claimOpen: async (input: unknown) => {
          const { threadId: asked, after } = input as { threadId: string; after?: number };
          if (server.thread && server.thread !== asked) return { open: null };
          if (server.waiting && after !== undefined && server.waiting.at <= after)
            server.waiting = null;
          return { open: await answer(server.waiting) };
        },
      },
    },
  );
  mounted.push(slot);
  return slot;
}

const claims = (slot: ReturnType<typeof renderSlot>) =>
  slot.inspection.rpcCalls.filter((call) => call.method === "claimOpen");

const event = (threadId: string, { sessionId, title, at }: PendingOpen) => ({
  threadId,
  sessionId,
  title,
  at,
});

const focusOf = ({ sessionId, title }: PendingOpen) => ({
  method: "openThreadPanel",
  options: { actionId: "whiteboard", title, params: { sessionId } },
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A claim answer the test releases. */
function held() {
  let release: (() => void) | undefined;
  return {
    answer: (waiting: PendingOpen | null) =>
      new Promise<PendingOpen | null>((resolve) => {
        release = () => resolve(waiting);
      }),
    held: () => typeof release === "function",
    release: () => release!(),
  };
}

afterEach(() => {
  for (const slot of mounted) slot.lifecycle.unmount();
  mounted = [];
});

test("focuses the Whiteboard tab only in a pane showing that thread, and renders nothing", async () => {
  const mine = pane("t1");
  const other = pane("t2");
  const plan = open();

  for (const slot of [other, mine])
    await slot.behavior.emitRealtime("whiteboard:open", event("t1", plan));

  expect(mine.container.innerHTML).toBe("");
  expect(mine.inspection.navigateCalls).toEqual([focusOf(plan)]);
  expect(other.inspection.navigateCalls).toEqual([]);
  // The focusing pane tells the server it is done with this open.
  expect(claims(mine)).toContainEqual({
    method: "claimOpen",
    input: { threadId: "t1", after: plan.at },
  });
});

test("never focuses on a compact viewport", async () => {
  const phone = pane("t1", { compact: true });

  await phone.behavior.emitRealtime("whiteboard:open", event("t1", open()));

  expect(phone.inspection.navigateCalls).toEqual([]);
  expect(claims(phone)).toEqual([]);
});

test("two panes on the same thread focus once per open; a compact pane does not use it up", async () => {
  const phone = pane("t1", { compact: true });
  const left = pane("t1");
  const right = pane("t1");

  const first = open();
  for (const slot of [phone, left, right])
    await slot.behavior.emitRealtime("whiteboard:open", event("t1", first));
  expect(left.inspection.navigateCalls).toEqual([focusOf(first)]);
  expect(right.inspection.navigateCalls).toEqual([]);

  const second = open();
  for (const slot of [right, left])
    await slot.behavior.emitRealtime("whiteboard:open", event("t1", second));
  expect(right.inspection.navigateCalls).toEqual([focusOf(second)]);
  expect(left.inspection.navigateCalls).toEqual([focusOf(first)]);
});

test("an older open never focuses after a newer one", async () => {
  const slot = pane("t1");
  const older = open("s-old", "Older");
  const newer = open("s-new", "Newer");

  await slot.behavior.emitRealtime("whiteboard:open", event("t1", newer));
  await slot.behavior.emitRealtime("whiteboard:open", event("t1", older));

  expect(slot.inspection.navigateCalls).toEqual([focusOf(newer)]);
});

test("ignores malformed payloads and other channels", async () => {
  const slot = pane("t1");

  await slot.behavior.emitRealtime("whiteboard:open", { threadId: "t1", sessionId: "s1" });
  await slot.behavior.emitRealtime("whiteboard:changed", event("t1", open()));

  expect(slot.inspection.navigateCalls).toEqual([]);
});

test("on mount, focuses the open an agent left while the thread was not shown, then forgets it", async () => {
  const plan = open();
  const server: Server = { waiting: plan };
  const slot = pane("t-mount", { server });

  await vi.waitFor(() => expect(slot.inspection.navigateCalls).toEqual([focusOf(plan)]));
  await vi.waitFor(() => expect(server.waiting).toBeNull());
  expect(claims(slot)).toEqual([
    { method: "claimOpen", input: { threadId: "t-mount" } },
    { method: "claimOpen", input: { threadId: "t-mount", after: plan.at } },
  ]);
});

test("on mount with nothing waiting, focuses nothing", async () => {
  const slot = pane("t-empty");

  await vi.waitFor(() => expect(claims(slot)).toHaveLength(1));
  await tick();
  expect(slot.inspection.navigateCalls).toEqual([]);
});

test("a compact viewport never claims, so a later desktop visit still focuses", async () => {
  const plan = open();
  const server: Server = { waiting: plan };
  const phone = pane("t1", { compact: true, server });

  await tick();
  expect(claims(phone)).toEqual([]);

  const desktop = pane("t1", { server });
  await vi.waitFor(() => expect(desktop.inspection.navigateCalls).toEqual([focusOf(plan)]));
  expect(phone.inspection.navigateCalls).toEqual([]);
});

test("a live open also forgets the server's copy, so the next visit does not refocus", async () => {
  const server: Server = { waiting: null };
  const slot = pane("t1", { server });
  await vi.waitFor(() => expect(claims(slot)).toHaveLength(1));

  // The agent's open leaves a copy on the server, then reaches this pane live.
  const plan = open();
  server.waiting = plan;
  await slot.behavior.emitRealtime("whiteboard:open", event("t1", plan));

  expect(slot.inspection.navigateCalls).toEqual([focusOf(plan)]);
  await vi.waitFor(() => expect(server.waiting).toBeNull());
  const next = pane("t1", { server });
  await vi.waitFor(() => expect(claims(next)).toHaveLength(1));
  await tick();
  expect(next.inspection.navigateCalls).toEqual([]);
});

test("a claim that answers after a live open focused the tab does not focus again", async () => {
  const older = open("s0", "Older");
  const server: Server = { waiting: older };
  const gate = held();
  const slot = pane("t1", {
    server,
    answer: (waiting) => (gate.held() ? waiting : gate.answer(waiting)),
  });
  await vi.waitFor(() => expect(gate.held()).toBe(true));

  const newer = open();
  await slot.behavior.emitRealtime("whiteboard:open", event("t1", newer));
  gate.release();
  await tick();

  expect(slot.inspection.navigateCalls).toEqual([focusOf(newer)]);
});

test("a slow claim in one pane does not focus after another pane focused a newer open", async () => {
  const older = open("s0", "Older");
  const server: Server = { waiting: older };
  const gate = held();
  const slow = pane("t1", { server, answer: gate.answer });
  await vi.waitFor(() => expect(gate.held()).toBe(true));

  const other = pane("t1", { server });
  const newer = open();
  await other.behavior.emitRealtime("whiteboard:open", event("t1", newer));
  gate.release();
  await tick();

  expect(other.inspection.navigateCalls.at(-1)).toEqual(focusOf(newer));
  expect(slow.inspection.navigateCalls).toEqual([]);
});

test("a pane claims once it is connected, so an open sent while it was offline still focuses", async () => {
  const plan = open();
  const server: Server = { waiting: plan };
  const slot = pane("t1", { server, connection: "reconnecting" });

  await tick();
  expect(claims(slot)).toEqual([]);

  await slot.behavior.setRealtimeConnectionState("connected");
  await vi.waitFor(() => expect(slot.inspection.navigateCalls).toEqual([focusOf(plan)]));

  // A drop and reconnect claims again, and finds nothing new.
  await slot.behavior.setRealtimeConnectionState("reconnecting");
  await slot.behavior.setRealtimeConnectionState("connected");
  await vi.waitFor(() => expect(claims(slot)).toHaveLength(3));
  await tick();
  expect(slot.inspection.navigateCalls).toEqual([focusOf(plan)]);
});

test("a claim from before a reconnect does not focus over the open the reconnect found", async () => {
  const older = open("s0", "Older");
  const server: Server = { waiting: older };
  const gate = held();
  const slot = pane("t1", {
    server,
    answer: (waiting) => (gate.held() ? waiting : gate.answer(waiting)),
  });
  await vi.waitFor(() => expect(gate.held()).toBe(true));

  const newer = open();
  server.waiting = newer;
  await slot.behavior.setRealtimeConnectionState("reconnecting");
  await slot.behavior.setRealtimeConnectionState("connected");
  await vi.waitFor(() => expect(slot.inspection.navigateCalls).toEqual([focusOf(newer)]));
  gate.release();
  await tick();

  expect(slot.inspection.navigateCalls).toEqual([focusOf(newer)]);
});

test("a claim that answers after the pane left leaves the open for the thread's next pane", async () => {
  const plan = open();
  const server: Server = { waiting: plan };
  const gate = held();
  const passing = pane("t1", { server, answer: gate.answer });
  await vi.waitFor(() => expect(gate.held()).toBe(true));
  passing.lifecycle.unmount();

  // The next pane mounts before the departed pane's answer lands.
  const back = pane("t1", { server });
  gate.release();

  await vi.waitFor(() => expect(back.inspection.navigateCalls).toEqual([focusOf(plan)]));
  expect(passing.inspection.navigateCalls).toEqual([]);
});

test("a pane that left before its claim answered focuses nothing, even when no pane replaced it", async () => {
  const plan = open();
  const server: Server = { waiting: plan };
  const gate = held();
  const passing = pane("t-left", { server, answer: gate.answer });
  await vi.waitFor(() => expect(gate.held()).toBe(true));
  passing.lifecycle.unmount();
  gate.release();
  await tick();

  expect(passing.inspection.navigateCalls).toEqual([]);
  expect(server.waiting).toEqual(plan);
  const back = pane("t-left", { server });
  await vi.waitFor(() => expect(back.inspection.navigateCalls).toEqual([focusOf(plan)]));
});

test("a claim that answers after the pane switched thread or turned compact focuses nothing", async () => {
  for (const next of [
    { threadId: "t-switch-b", isCompactViewport: false },
    { threadId: "t-switch-a", isCompactViewport: true },
  ]) {
    const plan = open();
    const server: Server = { waiting: plan, thread: "t-switch-a" };
    const gate = held();
    const slot = pane("t-switch-a", { server, answer: gate.answer });
    await vi.waitFor(() => expect(gate.held()).toBe(true));

    slot.lifecycle.rerender(<OpenListener projectId="p1" {...next} />);
    gate.release();
    await tick();

    expect(slot.inspection.navigateCalls).toEqual([]);
    expect(
      claims(slot).filter((call) => (call.input as { after?: number }).after === plan.at),
    ).toEqual([]);
    slot.lifecycle.unmount();
  }
});
