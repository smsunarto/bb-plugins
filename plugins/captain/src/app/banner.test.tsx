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

test("the keys work without a visible hint: no keycap, number or framed letter renders", async () => {
  const { slot } = render(CAPTAIN, [decision]);
  const card = await slot.findByTestId("captain-needs-you");
  act(() => card.focus());
  const answers = ["Redis", "SQLite", "No cache"].map((name) =>
    slot.getByRole("button", { name: new RegExp(name, "u") }),
  );
  answers.forEach((button, index) => {
    expect(button.getAttribute("aria-keyshortcuts")).toBe(String(index + 1));
    expect(button.textContent).not.toMatch(/\d/u);
  });
  const later = slot.getByRole("button", { name: "Later" });
  const skip = slot.getByRole("button", { name: "Skip" });
  expect(later.getAttribute("aria-keyshortcuts")).toBe("L");
  expect(skip.getAttribute("aria-keyshortcuts")).toBe("S");
  for (const button of [...answers, later, skip]) {
    expect(button.querySelector("[aria-hidden]")).toBeNull();
  }
  // The label reads whole, and no element inside the button frames a part of
  // it, such as its first letter; a span wrapping the whole word is fine.
  for (const [button, label] of [
    [later, "Later"],
    [skip, "Skip"],
  ] as const) {
    expect(button.textContent).toBe(label);
    const framed = [...button.querySelectorAll("*")].filter((each) => each.textContent !== label);
    expect(framed.map((each) => each.textContent)).toEqual([]);
  }
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
  const layout = layOut({ lines: 2, content: 4 });
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
 * Lays the detail box out as a browser would, in lines of 16px: collapsed it
 * shows two of the content's lines and scrolls the rest; open it shows them
 * all, so open it never looks clipped. The ResizeObserver reports after each
 * layout, as the browser's does.
 */
function layOut(layout: { lines: number; content: number }) {
  const observers = new Set<{ callback: ResizeObserverCallback; targets: Set<Element> }>();
  const box = (element: Element) =>
    element.hasAttribute("data-detail-box")
      ? element.parentElement?.querySelector("[aria-expanded=true]")
        ? layout.content
        : Math.min(layout.lines, layout.content)
      : null;
  const report = (observer: { callback: ResizeObserverCallback; targets: Set<Element> }) =>
    observer.callback(
      [...observer.targets].map((target) => ({ target }) as ResizeObserverEntry),
      {} as ResizeObserver,
    );
  const previous = globalThis.ResizeObserver;
  // jsdom lays nothing out; these stand in for its zero heights on `Element` until `restore`.
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return (box(this) ?? 0) * 16;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return box(this) === null ? 0 : layout.content * 16;
    },
  });
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
    /** Lay out again at a new width or with new content, and report it. */
    relayout(next: { lines: number; content: number }) {
      Object.assign(layout, next);
      act(() => observers.forEach(report));
    },
    restore() {
      globalThis.ResizeObserver = previous;
      const prototype = HTMLElement.prototype as Partial<
        Record<"clientHeight" | "scrollHeight", number>
      >;
      delete prototype.clientHeight;
      delete prototype.scrollHeight;
    },
  };
}

test("More shows only when the two-line box cuts the detail off, and follows new content", async () => {
  const layout = layOut({ lines: 2, content: 2 });
  try {
    const { slot } = render(CAPTAIN, [decision]);
    const card = await slot.findByTestId("captain-needs-you");
    // The detail shows collapsed, with nothing to open.
    expect(card.textContent).toContain("Builds re-download deps.");
    expect(slot.queryByRole("button", { name: "More" })).toBeNull();
    // Content grows under a box that stays two lines tall.
    layout.relayout({ lines: 2, content: 4 });
    const more = slot.getByRole("button", { name: "More" });
    act(() => more.click());
    expect(slot.getByRole("button", { name: "Less" }).getAttribute("aria-expanded")).toBe("true");
    expect(card.textContent).toContain("Redis is shared.");
  } finally {
    layout.restore();
  }
});

test("Less keeps focus: the open detail fits its box, yet the toggle stays and reads More", async () => {
  const layout = layOut({ lines: 2, content: 4 });
  try {
    const { slot } = render(CAPTAIN, [decision]);
    await slot.findByTestId("captain-needs-you");
    act(() => slot.getByRole("button", { name: "More" }).click());
    // Open, the box holds every line, as it does in a browser.
    layout.relayout({ lines: 2, content: 4 });
    const less = slot.getByRole("button", { name: "Less" });
    act(() => less.focus());
    act(() => less.click());
    expect(document.activeElement).toBe(less);
    expect(less.textContent).toBe("More");
    expect(less.getAttribute("aria-expanded")).toBe("false");
  } finally {
    layout.restore();
  }
});

test("when Less finds the preview now fits, More goes and focus moves to the banner", async () => {
  const layout = layOut({ lines: 2, content: 4 });
  try {
    const { slot, of } = render(CAPTAIN, [decision]);
    const card = await slot.findByTestId("captain-needs-you");
    act(() => slot.getByRole("button", { name: "More" }).click());
    // Wider while open, or shorter after a refetch: two lines now hold it all.
    layout.relayout({ lines: 4, content: 4 });
    const less = slot.getByRole("button", { name: "Less" });
    act(() => less.focus());
    act(() => less.click());
    expect(slot.queryByRole("button", { name: /More|Less/u })).toBeNull();
    expect(document.activeElement).toBe(card);
    // The next Enter was meant for the toggle: it answers nothing.
    fireEvent.keyDown(card, { key: "Enter" });
    await new Promise((settle) => setTimeout(settle, 30));
    expect(of("resolveAsk")).toEqual([]);
  } finally {
    layout.restore();
  }
});

test("a held Enter that repeats onto the banner answers nothing", async () => {
  const { slot, of } = render(CAPTAIN, [decision]);
  const card = await slot.findByTestId("captain-needs-you");
  act(() => card.focus());
  fireEvent.keyDown(card, { key: "Enter", repeat: true });
  await new Promise((settle) => setTimeout(settle, 30));
  expect(of("resolveAsk")).toEqual([]);
});

test("the next item starts collapsed, whatever the last one showed", async () => {
  const layout = layOut({ lines: 2, content: 4 });
  try {
    const { slot } = render(CAPTAIN, [decision, access]);
    const card = await slot.findByTestId("captain-needs-you");
    expect(card.textContent).toContain("Grant the crew a deploy key");
    act(() => slot.getByRole("button", { name: "More" }).click());
    act(() => slot.getByRole("button", { name: "Skip" }).click());
    await waitFor(() => expect(card.textContent).toContain("Pick the cache backend"));
    expect(slot.getByRole("button", { name: "More" }).getAttribute("aria-expanded")).toBe("false");
  } finally {
    layout.restore();
  }
});

test("a collapsed detail shows its first lines again, however the open one was scrolled", async () => {
  const layout = layOut({ lines: 2, content: 12 });
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
  } finally {
    layout.restore();
  }
});

/** A link past the shown lines of the collapsed detail, focused by `how`. */
function focusHiddenLink(card: HTMLElement, how: "keyboard" | "pointer") {
  const box = card.querySelector<HTMLElement>("[data-detail-box]")!;
  const link = document.createElement("a");
  link.href = "#thread";
  link.textContent = "thr_crew";
  const matches = link.matches.bind(link);
  Object.defineProperty(link, "matches", {
    value: (selector: string) =>
      selector === ":focus-visible" ? how === "keyboard" : matches(selector),
  });
  box.append(link);
  let scrollTop = 0;
  Object.defineProperty(box, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
    },
  });
  act(() => link.focus());
  // The browser scrolls the clipped box to bring the focused link into view.
  scrollTop = 32;
  fireEvent.scroll(box);
  return { link, scrollTop: () => scrollTop };
}

test("Tab onto a link hidden in the collapsed detail opens it", async () => {
  const layout = layOut({ lines: 2, content: 4 });
  try {
    const { slot } = render(CAPTAIN, [decision]);
    const card = await slot.findByTestId("captain-needs-you");
    focusHiddenLink(card, "keyboard");
    expect(slot.getByRole("button", { name: "Less" }).getAttribute("aria-expanded")).toBe("true");
  } finally {
    layout.restore();
  }
});

test("a click on a chip in the collapsed detail acts and leaves the detail as it was", async () => {
  const layout = layOut({ lines: 2, content: 4 });
  try {
    const { slot } = render(CAPTAIN, [decision]);
    const card = await slot.findByTestId("captain-needs-you");
    const { link, scrollTop } = focusHiddenLink(card, "pointer");
    const clicks: Event[] = [];
    link.addEventListener("click", (event) => {
      event.preventDefault();
      clicks.push(event);
    });
    act(() => link.click());
    expect(clicks).toHaveLength(1);
    expect(slot.getByRole("button", { name: "More" }).getAttribute("aria-expanded")).toBe("false");
    expect(scrollTop()).toBe(0);
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
