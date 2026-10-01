// @vitest-environment jsdom
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, expect, test, vi } from "vitest";
import { NONCE_TTL_MS, OpenListener } from "./open-listener.tsx";

const registration = { component: OpenListener };
let mounted: ReturnType<typeof renderSlot>[] = [];

function pane(threadId: string, isCompactViewport = false) {
  const slot = renderSlot(
    registration,
    { threadId, projectId: "p1", isCompactViewport },
    { pluginId: "whiteboard", context: { threadId, projectId: "p1" } },
  );
  mounted.push(slot);
  return slot;
}

const event = (threadId: string, nonce: string) => ({
  threadId,
  sessionId: "s1",
  title: "Plan",
  nonce,
});

afterEach(() => {
  for (const slot of mounted) slot.lifecycle.unmount();
  mounted = [];
  vi.useRealTimers();
});

test("focuses the Whiteboard tab only in a pane showing that thread, and renders nothing", async () => {
  const mine = pane("t1");
  const other = pane("t2");

  for (const slot of [other, mine])
    await slot.behavior.emitRealtime("whiteboard:open", event("t1", "n-1"));

  expect(mine.container.innerHTML).toBe("");
  expect(mine.inspection.navigateCalls).toEqual([
    {
      method: "openThreadPanel",
      options: { actionId: "whiteboard", title: "Plan", params: { sessionId: "s1" } },
    },
  ]);
  expect(other.inspection.navigateCalls).toEqual([]);
});

test("never focuses on a compact viewport", async () => {
  const phone = pane("t1", true);

  await phone.behavior.emitRealtime("whiteboard:open", event("t1", "n-compact"));

  expect(phone.inspection.navigateCalls).toEqual([]);
});

test("two panes on the same thread focus once per nonce; a compact pane does not use it up", async () => {
  const phone = pane("t1", true);
  const left = pane("t1");
  const right = pane("t1");

  for (const slot of [phone, left, right])
    await slot.behavior.emitRealtime("whiteboard:open", event("t1", "n-split"));
  expect(left.inspection.navigateCalls).toHaveLength(1);
  expect(right.inspection.navigateCalls).toHaveLength(0);

  // A later open is a new nonce, so it focuses again.
  for (const slot of [right, left])
    await slot.behavior.emitRealtime("whiteboard:open", event("t1", "n-split-2"));
  expect(right.inspection.navigateCalls).toHaveLength(1);
  expect(left.inspection.navigateCalls).toHaveLength(1);
});

test("a handled nonce is forgotten after a minute", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-30T12:00:00Z"));
  const slot = pane("t1");

  await slot.behavior.emitRealtime("whiteboard:open", event("t1", "n-ttl"));
  await slot.behavior.emitRealtime("whiteboard:open", event("t1", "n-ttl"));
  expect(slot.inspection.navigateCalls).toHaveLength(1);

  vi.setSystemTime(new Date(Date.now() + NONCE_TTL_MS));
  await slot.behavior.emitRealtime("whiteboard:open", event("t1", "n-ttl"));
  expect(slot.inspection.navigateCalls).toHaveLength(2);
});

test("ignores malformed payloads and other channels", async () => {
  const slot = pane("t1");

  await slot.behavior.emitRealtime("whiteboard:open", { threadId: "t1", sessionId: "s1" });
  await slot.behavior.emitRealtime("whiteboard:changed", event("t1", "n-other"));

  expect(slot.inspection.navigateCalls).toEqual([]);
});
