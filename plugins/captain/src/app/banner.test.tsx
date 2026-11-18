// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { QueueItem } from "../contract/queue.ts";
import { captainContract } from "../contract/rpc.ts";

const app = await loadPluginApp(() => import("./app.tsx"));
const banner = app.composerCustomizations.find((each) => each.id === "needs-you")!.banners![0]!;

afterEach(cleanup);

const CAPTAIN = "thr_captain";
const NOW = Date.now();

const decision: QueueItem = {
  kind: "ask",
  key: "ask:a1",
  id: "a1",
  askKind: "decision",
  text: "Pick the cache backend",
  detail: "Builds re-download deps. Redis is shared.",
  options: ["Redis", "SQLite", "No cache"],
  task: "PLUG-8",
  since: NOW - 40 * 60_000,
  answer: null,
  snoozedUntil: null,
  skipOrder: null,
};
const access: QueueItem = {
  ...decision,
  key: "ask:a2",
  id: "a2",
  askKind: "access",
  text: "Grant the crew a deploy key",
  options: ["Grant read-only", "Grant read-write"],
};

type Calls = { method: string; input: unknown }[];

function render(
  threadId: string,
  asks: QueueItem[],
  options: { since?: unknown; crew?: QueueItem[]; crewFails?: boolean; sdk?: unknown } = {},
) {
  const calls: Calls = [];
  const log =
    <T,>(method: string, result: (input: never) => T) =>
    (input: never) => {
      calls.push({ method, input });
      return result(input);
    };
  const slot = renderSlot(banner as never, {} as never, {
    experimental_rpcContract: captainContract,
    composer: { scope: { kind: "thread", threadId } },
    rpc: {
      captains: log("captains", () => ({ ids: [CAPTAIN] })),
      asks: log("asks", () => ({ items: asks })),
      crew: log("crew", () => {
        if (options.crewFails) throw new Error("bb did not answer");
        return { items: options.crew ?? [] };
      }),
      sinceYouLeft: log(
        "sinceYouLeft",
        () => options.since ?? { cutoff: null, done: [], ready: [], failed: [] },
      ),
      resolveAsk: log("resolveAsk", () => ({ state: "answered", warnings: [] })),
      defer: log("defer", () => ({ snoozedUntil: null, skipOrder: null })),
      markSeen: log("markSeen", () => ({ at: NOW })),
    } as never,
    ...(options.sdk === undefined ? {} : { sdk: options.sdk as never }),
  });
  return { slot, calls, of: (method: string) => calls.filter((call) => call.method === method) };
}

test("on a thread that is not a Captain, the banner reads only the Captain list and draws nothing", async () => {
  const { slot, calls } = render("thr_other", [decision]);
  await waitFor(() => expect(calls.map((call) => call.method)).toEqual(["captains"]));
  await new Promise((settle) => setTimeout(settle, 30));
  expect(slot.queryByTestId("captain-needs-you")).toBeNull();
  expect(calls.map((call) => call.method)).toEqual(["captains"]);
});

test("one item at a time, in queue order, with its place, task, age and recommended option", async () => {
  const { slot } = render(CAPTAIN, [decision, access]);
  const card = await slot.findByTestId("captain-needs-you");
  // Access asks come before decisions.
  expect(card.textContent).toContain("Grant the crew a deploy key");
  expect(card.textContent).not.toContain("Pick the cache backend");
  expect(card.textContent).toContain("1 of 2 · PLUG-8 · 40m");
  // The first option says it is the recommended one; the others do not.
  expect(slot.getByRole("button", { name: /Grant read-only/u }).textContent).toContain(
    "Recommended",
  );
  expect(slot.getByRole("button", { name: /Grant read-write/u }).textContent).not.toContain(
    "Recommended",
  );
});

test("a lone item shows no place in the queue", async () => {
  const { slot } = render(CAPTAIN, [decision]);
  const card = await slot.findByTestId("captain-needs-you");
  expect(card.textContent).toContain("PLUG-8 · 40m");
  expect(card.textContent).not.toContain("1 of 1");
});

test("keys: a number answers, S skips, L hides it, Enter on the banner picks the recommended", async () => {
  const { slot, of } = render(CAPTAIN, [decision]);
  const card = await slot.findByTestId("captain-needs-you");
  act(() => card.focus());
  fireEvent.keyDown(card, { key: "s" });
  fireEvent.keyDown(card, { key: "L" });
  await waitFor(() =>
    expect(of("defer").map((call) => call.input)).toEqual([
      { captainId: CAPTAIN, key: "ask:a1", action: "skip" },
      { captainId: CAPTAIN, key: "ask:a1", action: "later" },
    ]),
  );
  // Later hid the only item, so a number has nothing left to answer.
  fireEvent.keyDown(card, { key: "2" });
  expect(of("resolveAsk")).toEqual([]);
  cleanup();
  const again = render(CAPTAIN, [decision]);
  const fresh = await again.slot.findByTestId("captain-needs-you");
  fireEvent.keyDown(fresh, { key: "2" });
  await waitFor(() =>
    expect(again.of("resolveAsk").map((call) => call.input)).toEqual([
      { askId: "a1", answer: "SQLite" },
    ]),
  );
});

test("Enter picks the recommended option only when the banner itself has focus", async () => {
  const { slot, of } = render(CAPTAIN, [decision]);
  const card = await slot.findByTestId("captain-needs-you");
  fireEvent.keyDown(slot.getByRole("button", { name: /Later/u }), { key: "Enter" });
  fireEvent.keyDown(card, { key: "Enter" });
  await waitFor(() =>
    expect(of("resolveAsk").map((call) => call.input)).toEqual([{ askId: "a1", answer: "Redis" }]),
  );
});

test("Other… answers in words; typing in it is not a key shortcut", async () => {
  const { slot, of } = render(CAPTAIN, [decision]);
  await slot.findByTestId("captain-needs-you");
  act(() => slot.getByRole("button", { name: "Other…" }).click());
  const box = slot.getByRole("textbox", { name: "Your answer" });
  fireEvent.keyDown(box, { key: "1" });
  fireEvent.change(box, { target: { value: "Use the shared cache" } });
  fireEvent.submit(box.closest("form")!);
  await waitFor(() =>
    expect(of("resolveAsk").map((call) => call.input)).toEqual([
      { askId: "a1", answer: "Use the shared cache" },
    ]),
  );
});

test("an answer the Captain does not have yet shows Sending… and no answer buttons", async () => {
  const { slot } = render(CAPTAIN, [{ ...decision, answer: "SQLite" } as QueueItem]);
  const card = await slot.findByTestId("captain-needs-you");
  expect(card.textContent).toContain('Answered "SQLite" · Sending…');
  expect(slot.queryByRole("button", { name: /Redis/u })).toBeNull();
  expect(slot.queryByRole("button", { name: "Later" })).toBeNull();
});

test("a ship ask offers no Other…, and More expands the full detail", async () => {
  const ship = { ...decision, askKind: "ship", options: ["Merge", "Hold"] } as QueueItem;
  const layout = layOut({ box: 32, content: 64 });
  try {
    const { slot } = render(CAPTAIN, [ship]);
    const card = await slot.findByTestId("captain-needs-you");
    expect(slot.queryByRole("button", { name: "Other…" })).toBeNull();
    expect(card.textContent).toContain("Redis is shared.");
    const more = slot.getByRole("button", { name: "More" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    act(() => more.click());
    const less = slot.getByRole("button", { name: "Less" });
    expect(less.getAttribute("aria-expanded")).toBe("true");
    act(() => less.click());
    expect(slot.getByRole("button", { name: "More" }).getAttribute("aria-expanded")).toBe("false");
  } finally {
    layout.restore();
  }
});

/**
 * A ResizeObserver that reports the detail's clipping box and its content at
 * the heights set here, as a browser would after layout. Each observed element
 * gets its own height, so measuring the wrong one gives the wrong answer.
 */
function layOut(heights: { box: number; content: number }) {
  const observers = new Set<{ callback: ResizeObserverCallback; targets: Set<Element> }>();
  const height = (target: Element) =>
    target.hasAttribute("data-detail-content") ? heights.content : heights.box;
  const report = (observer: { callback: ResizeObserverCallback; targets: Set<Element> }) =>
    observer.callback(
      [...observer.targets].map(
        (target) =>
          ({
            target,
            borderBoxSize: [{ blockSize: height(target), inlineSize: 300 }],
            contentRect: { height: height(target) },
          }) as unknown as ResizeObserverEntry,
      ),
      {} as ResizeObserver,
    );
  const previous = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    readonly entry: { callback: ResizeObserverCallback; targets: Set<Element> };
    constructor(callback: ResizeObserverCallback) {
      this.entry = { callback, targets: new Set() };
      observers.add(this.entry);
    }
    observe(target: Element) {
      this.entry.targets.add(target);
      report(this.entry);
    }
    unobserve() {}
    disconnect() {
      observers.delete(this.entry);
    }
  };
  return {
    /** Change the heights and deliver them, as a resize or new content would. */
    resize(next: { box: number; content: number }) {
      Object.assign(heights, next);
      act(() => observers.forEach(report));
    },
    restore() {
      globalThis.ResizeObserver = previous;
    },
  };
}

test("More shows only when the two-line box cuts the detail off, and follows new content", async () => {
  const layout = layOut({ box: 32, content: 32 });
  try {
    const { slot } = render(CAPTAIN, [decision]);
    const card = await slot.findByTestId("captain-needs-you");
    // The detail shows collapsed, with nothing to open.
    expect(card.textContent).toContain("Builds re-download deps.");
    expect(slot.queryByRole("button", { name: "More" })).toBeNull();
    // Content grows under a box that stays two lines tall.
    layout.resize({ box: 32, content: 64 });
    const more = slot.getByRole("button", { name: "More" });
    act(() => more.click());
    expect(slot.getByRole("button", { name: "Less" }).getAttribute("aria-expanded")).toBe("true");
    expect(card.textContent).toContain("Redis is shared.");
  } finally {
    layout.restore();
  }
});

test("a collapsed detail shows its first lines again, however the open one was scrolled", async () => {
  const layout = layOut({ box: 32, content: 200 });
  try {
    const { slot } = render(CAPTAIN, [decision]);
    const card = await slot.findByTestId("captain-needs-you");
    const box = card.querySelector<HTMLElement>("[data-detail-box]")!;
    let scrollTop = 0;
    Object.defineProperty(box, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });
    act(() => slot.getByRole("button", { name: "More" }).click());
    scrollTop = 120;
    act(() => slot.getByRole("button", { name: "Less" }).click());
    expect(scrollTop).toBe(0);
    // Focus moving onto a hidden link scrolls the clipped box; it snaps back.
    scrollTop = 48;
    fireEvent.scroll(box);
    expect(scrollTop).toBe(0);
  } finally {
    layout.restore();
  }
});

test("keyboard focus reaching hidden detail opens it", async () => {
  const layout = layOut({ box: 32, content: 64 });
  try {
    const { slot } = render(CAPTAIN, [decision]);
    const card = await slot.findByTestId("captain-needs-you");
    fireEvent.focusIn(card.querySelector("[data-detail-content]")!);
    expect(slot.getByRole("button", { name: "Less" })).toBeTruthy();
  } finally {
    layout.restore();
  }
});

test("when Less goes away as the detail collapses, focus stays in the banner", async () => {
  const layout = layOut({ box: 32, content: 64 });
  try {
    const { slot } = render(CAPTAIN, [decision]);
    const card = await slot.findByTestId("captain-needs-you");
    act(() => slot.getByRole("button", { name: "More" }).click());
    // Wider now: two lines would hold it all.
    layout.resize({ box: 64, content: 64 });
    const less = slot.getByRole("button", { name: "Less" });
    act(() => less.focus());
    act(() => less.click());
    expect(slot.queryByRole("button", { name: /More|Less/u })).toBeNull();
    expect(document.activeElement).toBe(card);
  } finally {
    layout.restore();
  }
});

test("Later and Skip clicks defer the item on show", async () => {
  const { slot, of } = render(CAPTAIN, [decision]);
  await slot.findByTestId("captain-needs-you");
  act(() => slot.getByRole("button", { name: "Skip" }).click());
  act(() => slot.getByRole("button", { name: "Later" }).click());
  await waitFor(() =>
    expect(of("defer").map((call) => call.input)).toEqual([
      { captainId: CAPTAIN, key: "ask:a1", action: "skip" },
      { captainId: CAPTAIN, key: "ask:a1", action: "later" },
    ]),
  );
});

test("an empty queue shows Since you left; a count opens its tasks and Mark seen advances the cutoff", async () => {
  const { slot, of } = render(CAPTAIN, [], {
    since: {
      cutoff: NOW - 3_600_000,
      done: [
        { task: "PLUG-1", title: "One", threadId: null },
        { task: "PLUG-2", title: "Two", threadId: null },
      ],
      ready: [{ task: "PLUG-3", title: "Three", threadId: null }],
      failed: [],
    },
  });
  const line = await slot.findByTestId("captain-since");
  expect(line.textContent).toContain("All clear · since you left:");
  expect(line.textContent).toContain("2 done");
  expect(line.textContent).toContain("1 ready to ship");
  expect(line.textContent).not.toContain("failed");
  act(() => slot.getByRole("button", { name: "2 done" }).click());
  expect(slot.getByRole("link", { name: "PLUG-2" }).getAttribute("href")).toBe(
    "/plugins/scott-tasks/tasks/task/PLUG-2",
  );
  act(() => slot.getByRole("button", { name: "Mark seen" }).click());
  await waitFor(() => expect(of("markSeen")).toHaveLength(1));
});

test("an empty queue with nothing since you left draws nothing", async () => {
  const { slot, of } = render(CAPTAIN, []);
  await waitFor(() => expect(of("sinceYouLeft")).toHaveLength(1));
  expect(slot.queryByTestId("captain-since")).toBeNull();
  expect(slot.queryByTestId("captain-needs-you")).toBeNull();
});

test("leaving the thread records last seen; showing it does not", async () => {
  const { slot, of } = render(CAPTAIN, [decision]);
  await slot.findByTestId("captain-needs-you");
  expect(of("markSeen")).toHaveLength(0);
  slot.lifecycle.unmount();
  await waitFor(() => expect(of("markSeen")).toHaveLength(1));
});

test("a blocked crew row opens its thread", async () => {
  const blocked: QueueItem = {
    kind: "blocked",
    key: "blocked:int_1",
    threadId: "thr_crew",
    title: "secrets request: UNITY_TOKEN",
    interactionKind: "plugin",
    task: "PLUG-19",
    role: "Implement",
    since: NOW,
    snoozedUntil: null,
    skipOrder: null,
  };
  const { slot } = render(CAPTAIN, [decision], { crew: [blocked] });
  await slot.findByText("Implement needs you: secrets request: UNITY_TOKEN");
  act(() => slot.getByRole("button", { name: /Open thread/u }).click());
  expect(slot.inspection.navigateCalls).toEqual([
    expect.objectContaining({ method: "toThread", threadId: "thr_crew" }),
  ]);
});

test("when the crew read fails, asks still show, the card says so, and Skip still works", async () => {
  const { slot, of } = render(CAPTAIN, [decision], { crewFails: true });
  const card = await slot.findByTestId("captain-needs-you");
  await waitFor(() => expect(card.textContent).toContain("crew not read"));
  expect(card.textContent).toContain("Pick the cache backend");
  fireEvent.keyDown(card, { key: "s" });
  await waitFor(() =>
    expect(of("defer").map((call) => call.input)).toEqual([
      { captainId: CAPTAIN, key: "ask:a1", action: "skip" },
    ]),
  );
  expect(card.textContent).toContain("Pick the cache backend");
});

test("an errored Captain thread's Retry re-submits its failed turn", async () => {
  const retried: unknown[] = [];
  const errored: QueueItem = {
    kind: "health",
    key: `health:${CAPTAIN}:7000`,
    title: "Captain thread errored",
    detail: null,
    task: null,
    since: NOW,
    action: { kind: "retry-thread", threadId: CAPTAIN },
    snoozedUntil: null,
    skipOrder: null,
  };
  const { slot } = render(CAPTAIN, [decision], {
    crew: [errored],
    sdk: {
      threads: {
        retry: async (args: unknown) => {
          retried.push(args);
          return {};
        },
      },
    },
  });
  await slot.findByText("Captain thread errored");
  const retry = slot.getByRole("button", { name: /Retry/u });
  // Retry is the only action, not a recommendation among options.
  expect(retry.textContent).not.toContain("Recommended");
  act(() => retry.click());
  await waitFor(() => expect(retried).toEqual([{ threadId: CAPTAIN }]));
});
