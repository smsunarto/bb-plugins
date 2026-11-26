// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { DEFAULT_ICON_GLYPH } from "../contract/icon.ts";
import type { QueueItem } from "../contract/queue.ts";
import { asksTag, captainContract } from "../contract/rpc.ts";

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
  asks: QueueItem[] | (() => QueueItem[]),
  options: {
    crew?: QueueItem[];
    crewFails?: boolean;
    sdk?: unknown;
    resolve?: (input: {
      askId: string;
      answer: string;
    }) => Promise<{ state: "answered"; warnings: string[] }>;
    panelTabs?: unknown;
  } = {},
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
    experimental_panel: { openTab: () => true },
    rpc: {
      captains: log("captains", () => ({ ids: [CAPTAIN] })),
      asks: log("asks", () => ({ items: typeof asks === "function" ? asks() : asks })),
      crew: log("crew", () => {
        if (options.crewFails) throw new Error("bb did not answer");
        return { items: options.crew ?? [] };
      }),
      resolveAsk: log(
        "resolveAsk",
        (input) => options.resolve?.(input) ?? { state: "answered", warnings: [] },
      ),
      defer: log("defer", () => ({ snoozedUntil: null, skipOrder: null })),
    } as never,
    ...(options.sdk === undefined ? {} : { sdk: options.sdk as never }),
    ...(options.panelTabs === undefined
      ? {}
      : { experimental_panelTabs: options.panelTabs as never }),
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

test("two items show readable tabs in queue order and one answer panel", async () => {
  const { slot, of } = render(CAPTAIN, [decision, access]);
  const tabs = await slot.findAllByRole("tab");
  expect(tabs.map((tab) => tab.textContent)).toEqual([
    "Grant the crew a deploy key40m",
    "Pick the cache backend40m",
  ]);
  expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
  expect(slot.getByRole("tabpanel").textContent).toContain("PLUG-8");
  expect(slot.getByRole("button", { name: "Grant read-only Recommended" })).toBeDefined();
  expect(of("crew")).toHaveLength(1);

  act(() => tabs[1]!.click());
  expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
  expect(slot.queryByRole("button", { name: /Grant read-only/u })).toBeNull();
  act(() => slot.getByRole("button", { name: "SQLite" }).click());
  await waitFor(() =>
    expect(of("resolveAsk").map(({ input }) => input)).toEqual([{ askId: "a1", answer: "SQLite" }]),
  );
});

test("a lone item uses the same queue and answer panel", async () => {
  const { slot } = render(CAPTAIN, [decision]);
  const tab = await slot.findByRole("tab", { name: /Pick the cache backend/u });
  expect(tab.getAttribute("aria-selected")).toBe("true");
  expect(slot.getByRole("tabpanel").textContent).toContain("Pick the cache backend");
});

test("arrow keys choose among three or more asks and keep tab focus", async () => {
  const third = { ...decision, key: "ask:a3", id: "a3", text: "Third ask" } as const;
  const later = { ...decision, key: "ask:a4", id: "a4", snoozedUntil: NOW + 60_000 } as const;
  const { slot } = render(CAPTAIN, [decision, access, third, later]);
  const tabs = await slot.findAllByRole("tab");
  expect(tabs).toHaveLength(3);
  expect(slot.getByText("1 later")).toBeDefined();
  act(() => tabs[0]!.focus());
  fireEvent.keyDown(tabs[0]!, { key: "ArrowLeft" });
  expect(document.activeElement).toBe(tabs[2]);
  expect(tabs[2]?.getAttribute("aria-selected")).toBe("true");
  expect(slot.getByRole("tabpanel").textContent).toContain("Third ask");
  fireEvent.keyDown(tabs[2]!, { key: "ArrowRight" });
  expect(document.activeElement).toBe(tabs[0]);
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
  act(() => fresh.focus());
  fireEvent.keyDown(fresh, { key: "2" });
  await waitFor(() =>
    expect(again.of("resolveAsk").map((call) => call.input)).toEqual([
      { askId: "a1", answer: "SQLite" },
    ]),
  );
});

test("answer shortcuts use accessible attributes, with an icon-only Later and no visible Skip", async () => {
  const { slot } = render(CAPTAIN, [decision]);
  await slot.findByTestId("captain-needs-you");
  ["Redis", "SQLite", "No cache"].forEach((name, index) => {
    const button = slot.getByRole("button", { name: new RegExp(name, "u") });
    expect(button.getAttribute("aria-keyshortcuts")).toBe(String(index + 1));
    expect(button.textContent).not.toMatch(/\d/u);
  });
  const later = slot.getByRole("button", { name: "Later" });
  expect(later.getAttribute("aria-keyshortcuts")).toBe("L");
  expect(later.textContent).toBe("");
  expect(slot.queryByRole("button", { name: "Skip" })).toBeNull();
});

test("unfocused and pointer-focused controls do not arm letter or number shortcuts", async () => {
  const { slot, of } = render(CAPTAIN, [decision]);
  const card = await slot.findByTestId("captain-needs-you");
  fireEvent.keyDown(card, { key: "1" });
  const later = slot.getByRole("button", { name: "Later" });
  fireEvent.pointerDown(later);
  const matches = later.matches.bind(later);
  const pointerFocus = vi
    .spyOn(later, "matches")
    .mockImplementation((selector) => (selector === ":focus-visible" ? false : matches(selector)));
  act(() => later.focus());
  fireEvent.keyDown(later, { key: "L" });
  fireEvent.keyDown(later, { key: "2" });
  pointerFocus.mockRestore();
  expect(of("resolveAsk")).toEqual([]);
  expect(of("defer")).toEqual([]);
});

test("Enter picks the recommended option only when the banner itself has focus", async () => {
  const { slot, of } = render(CAPTAIN, [decision]);
  const card = await slot.findByTestId("captain-needs-you");
  fireEvent.keyDown(slot.getByRole("button", { name: /Later/u }), { key: "Enter" });
  act(() => card.focus());
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
function layOut(layout: { lines: number; content: number; horizontalOverflow?: boolean }) {
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
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return box(this) !== null && layout.horizontalOverflow ? 480 : 280;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => 280,
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
    /** Report as the browser does, between layout and paint: outside React, with no render after. */
    measure(next: { lines: number; content: number }) {
      Object.assign(layout, next);
      observers.forEach(report);
    },
    /** Lay out anew without reporting, as content that leaves the box its size. */
    resize(next: { lines: number; content: number }) {
      Object.assign(layout, next);
    },
    restore() {
      globalThis.ResizeObserver = previous;
      const prototype = HTMLElement.prototype as Partial<
        Record<"clientHeight" | "scrollHeight" | "clientWidth" | "scrollWidth", number>
      >;
      delete prototype.clientHeight;
      delete prototype.scrollHeight;
      delete prototype.clientWidth;
      delete prototype.scrollWidth;
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

test("More shows in the same paint as the clipped text: the measure itself shows it", async () => {
  const layout = layOut({ lines: 0, content: 0 });
  try {
    const { slot } = render(CAPTAIN, [decision]);
    await slot.findByTestId("captain-needs-you");
    expect(slot.queryByRole("button", { name: "More" })).toBeNull();
    // bb's renderer fills the box after the first commit; the browser measures before it paints.
    layout.measure({ lines: 2, content: 4 });
    expect(slot.getByRole("button", { name: "More" })).not.toBeNull();
  } finally {
    layout.restore();
  }
});

test("with nothing to measure the detail by, More stays hidden", async () => {
  const { slot } = render(CAPTAIN, [decision]);
  const card = await slot.findByTestId("captain-needs-you");
  expect(card.textContent).toContain("Builds re-download deps.");
  expect(slot.queryByRole("button", { name: /More|Less/u })).toBeNull();
});

test("a code block, diagram, table or image in two lines that fit still offers More", async () => {
  /** bb's renderer frames code and diagrams with a header of buttons. */
  const blocks: Record<string, () => Element> = {
    framed: () => {
      const frame = document.createElement("div");
      frame.innerHTML =
        "<div><span>sh</span><div><button>Copy code</button></div></div><pre><code>bun test</code></pre>";
      return frame;
    },
    table: () => document.createElement("table"),
    image: () => document.createElement("img"),
  };
  for (const [kind, block] of Object.entries(blocks)) {
    const layout = layOut({ lines: 2, content: 2 });
    try {
      const { slot } = render(CAPTAIN, [decision]);
      const card = await slot.findByTestId("captain-needs-you");
      expect(slot.queryByRole("button", { name: "More" }), kind).toBeNull();
      // The block arrives with bb's renderer, after the first commit; the box takes its size.
      card.querySelector("[data-detail-box] [data-testid=bb-markdown]")!.append(block());
      layout.relayout({ lines: 2, content: 2 });
      expect(slot.queryByRole("button", { name: "More" }), kind).not.toBeNull();
    } finally {
      layout.restore();
      cleanup();
    }
  }
});

test("new detail text under a box that keeps its size is measured afresh", async () => {
  const layout = layOut({ lines: 2, content: 2 });
  let detail = decision.detail;
  try {
    const { slot } = render(CAPTAIN, () => [{ ...decision, detail } as QueueItem]);
    const card = await slot.findByTestId("captain-needs-you");
    expect(slot.queryByRole("button", { name: "More" })).toBeNull();
    // A refetch brings a longer detail for the same ask; the two-line box stays two lines tall.
    detail =
      "Builds re-download deps. Redis is shared. SQLite is per runner, and it needs no network.";
    layout.resize({ lines: 2, content: 4 });
    await slot.experimental_invalidateRpc([asksTag(CAPTAIN)]);
    await waitFor(() => expect(card.textContent).toContain("needs no network"));
    expect(slot.getByRole("button", { name: "More" })).not.toBeNull();
  } finally {
    layout.restore();
  }
});

test("scrolling the open detail keeps its place", async () => {
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
    scrollTop = 48;
    fireEvent.scroll(box);
    expect(scrollTop).toBe(48);
    expect(slot.getByRole("button", { name: "Less" })).not.toBeNull();
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
    act(() => slot.getByRole("tab", { name: /Pick the cache backend/u }).click());
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

test("the Later icon defers the item on show", async () => {
  const { slot, of } = render(CAPTAIN, [decision]);
  await slot.findByTestId("captain-needs-you");
  act(() => slot.getByRole("button", { name: "Later" }).click());
  await waitFor(() =>
    expect(of("defer").map((call) => call.input)).toEqual([
      { captainId: CAPTAIN, key: "ask:a1", action: "later" },
    ]),
  );
});

test("an empty queue is one clear line with an action that opens Captain Overview", async () => {
  const { slot, calls } = render(CAPTAIN, []);
  const overview = await slot.findByRole("button", { name: "Overview" });
  const row = overview.parentElement!;
  expect(row.textContent).toBe("All clearOverview");
  expect(row.querySelector("ul")).toBeNull();
  const icon = row.querySelector("[data-icon]");
  expect(icon?.getAttribute("data-icon")).toBe(DEFAULT_ICON_GLYPH);
  expect(icon?.className).toContain("text-foreground");
  const label = slot.getByText("All clear");
  expect(label.className).toContain("text-foreground");
  expect(label.className).toContain("font-medium");
  fireEvent.click(overview);
  expect(slot.experimental_panelCalls).toEqual([
    {
      method: "openTab",
      options: {
        tab: {
          id: "overview",
          context: { kind: "thread" },
          availability: "fixed",
        },
      },
    },
  ]);
  expect(calls.map(({ method }) => method).sort()).toEqual(["asks", "captains", "crew"]);
});

test("unavailable crew does not report All clear", async () => {
  const { slot } = render(CAPTAIN, [], { crewFails: true });
  const label = await slot.findByText("Crew status unavailable");
  expect(slot.queryByText("All clear")).toBeNull();
  expect(slot.getByRole("button", { name: "Overview" })).toBeDefined();
  const icon = label.parentElement?.querySelector("[data-icon]");
  expect(icon?.getAttribute("data-icon")).toBe("AlertTriangle");
  expect(icon?.className).toContain("text-warning-text");
  expect(label.className).toContain("font-medium");
  expect(label.className).toContain("text-foreground");
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
  await slot.findByRole("button", { name: "Open thread" });
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
  act(() => card.focus());
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
  await slot.findByRole("button", { name: "Retry" });
  const retry = slot.getByRole("button", { name: /Retry/u });
  // Retry is the only action, not a recommendation among options.
  expect(retry.textContent).not.toContain("Recommended");
  act(() => retry.click());
  await waitFor(() => expect(retried).toEqual([{ threadId: CAPTAIN }]));
});

const infoOpen = {
  open: true,
  selectedKey: "info",
  tabs: [{ key: "info", title: "Info", status: null, closable: false, detail: { kind: "info" } }],
};

test("a Captain's panel already open at mount keeps its tab: that open was before the banner", async () => {
  const { slot, of } = render(CAPTAIN, [decision], { panelTabs: infoOpen });
  await waitFor(() => expect(of("asks").length).toBeGreaterThan(0));
  await new Promise((settle) => setTimeout(settle, 30));
  expect(slot.inspection.experimental_panelCalls).toEqual([]);
});

test("a Captain's closed panel is never opened by the banner", async () => {
  const { slot, of } = render(CAPTAIN, [decision], {
    panelTabs: { open: false, selectedKey: null, tabs: [] },
  });
  await waitFor(() => expect(of("asks").length).toBeGreaterThan(0));
  await new Promise((settle) => setTimeout(settle, 30));
  expect(slot.inspection.experimental_panelCalls).toEqual([]);
});

test("a ship panel does not answer on implicit Enter, and its Merge and Hold actions still work", async () => {
  const ship = { ...decision, askKind: "ship", options: ["Merge", "Hold"] } as const;
  const { slot, of } = render(CAPTAIN, [{ ...ship, options: [...ship.options] }]);
  const card = await slot.findByTestId("captain-needs-you");
  act(() => card.focus());
  fireEvent.keyDown(card, { key: "Enter" });
  expect(of("resolveAsk")).toEqual([]);
  expect(slot.getByRole("button", { name: "Merge Recommended" })).toBeDefined();
  fireEvent.click(slot.getByRole("button", { name: "Hold" }));
  await waitFor(() =>
    expect(of("resolveAsk").map(({ input }) => input)).toEqual([{ askId: "a1", answer: "Hold" }]),
  );
});

test("a Plan decision opens its full detail from the action row", async () => {
  const plan = {
    ...decision,
    text: "Approve the plan · Board drag reorder",
    options: ["Approve", "Revise"],
  };
  const { slot } = render(CAPTAIN, [plan]);
  const read = await slot.findByRole("button", { name: "Read plan" });
  expect(read.getAttribute("aria-expanded")).toBe("false");
  expect(slot.queryByRole("tablist")).toBeNull();
  act(() => read.click());
  expect(read.getAttribute("aria-expanded")).toBe("true");
  const details = document.getElementById(read.getAttribute("aria-controls")!);
  expect(details?.textContent).toContain(plan.detail);
});

test("two in-flight answers each have a selectable Sending panel until delivered", async () => {
  const delivered = new Set<string>();
  const release = new Map<string, () => void>();
  const { slot } = render(
    CAPTAIN,
    () => [decision, access].filter((item) => !delivered.has(item.id)),
    {
      resolve: ({ askId }) =>
        new Promise((done) => {
          release.set(askId, () => {
            delivered.add(askId);
            done({ state: "answered", warnings: [] });
          });
        }),
    },
  );
  fireEvent.click(await slot.findByRole("button", { name: "Grant read-write" }));
  fireEvent.click(await slot.findByRole("button", { name: "SQLite" }));
  const decisionTab = await slot.findByRole("tab", { name: /Pick the cache/u });
  const accessTab = slot.getByRole("tab", { name: /Grant the crew/u });
  fireEvent.click(decisionTab);
  const panel = slot.getByRole("tabpanel");
  expect(panel.textContent).toContain('Answered "SQLite"');
  expect(panel.getAttribute("aria-labelledby")).toBe(decisionTab.id);

  act(() => decisionTab.focus());
  fireEvent.keyDown(decisionTab, { key: "ArrowRight" });
  expect(document.activeElement).toBe(accessTab);
  expect(accessTab.getAttribute("aria-selected")).toBe("true");
  expect(panel.getAttribute("aria-labelledby")).toBe(accessTab.id);
  expect(panel.textContent).toContain('Answered "Grant read-write"');

  await act(async () => release.get("a2")!());
  await slot.experimental_invalidateRpc([asksTag(CAPTAIN)]);
  await waitFor(() => expect(slot.getAllByRole("tab")).toEqual([decisionTab]));
  expect(panel.textContent).toContain('Answered "SQLite"');
  await act(async () => release.get("a1")!());
  await slot.experimental_invalidateRpc([asksTag(CAPTAIN)]);
  await waitFor(() => expect(slot.queryByRole("tabpanel")).toBeNull());
});

test("a short plain line has neither fade nor More", async () => {
  const layout = layOut({ lines: 1, content: 1 });
  try {
    const { slot } = render(CAPTAIN, [decision]);
    const card = await slot.findByTestId("captain-needs-you");
    expect(slot.queryByRole("button", { name: "More" })).toBeNull();
    expect(card.querySelector("[data-preview-fade]")).toBeNull();
  } finally {
    layout.restore();
  }
});

test.each([
  ["Mermaid", "<div><div><button>Expand diagram</button></div></div>"],
  ["code", "<button>Copy</button><pre><code>bun test</code></pre>"],
])("a single-line %s preview that hides part of the block offers More", async (_kind, markup) => {
  const layout = layOut({ lines: 1, content: 1 });
  try {
    const { slot } = render(CAPTAIN, [decision]);
    const card = await slot.findByTestId("captain-needs-you");
    const frame = document.createElement("div");
    frame.innerHTML = markup;
    card.querySelector("[data-detail-box]")!.append(frame);
    layout.relayout({ lines: 1, content: 1 });
    expect(slot.getByRole("button", { name: "More" })).toBeDefined();
    expect(card.querySelector("[data-preview-fade]")).toBeNull();
  } finally {
    layout.restore();
  }
});

test("a single line clipped horizontally offers More", async () => {
  const layout = layOut({ lines: 1, content: 1, horizontalOverflow: true });
  try {
    const { slot } = render(CAPTAIN, [decision]);
    await slot.findByTestId("captain-needs-you");
    fireEvent.click(slot.getByRole("button", { name: "More" }));
    expect(slot.getByRole("button", { name: "Less" })).toBeDefined();
  } finally {
    layout.restore();
  }
});

test("Later comes before the accessible pen button and Other replaces the action row", async () => {
  const { slot } = render(CAPTAIN, [decision]);
  const trigger = await slot.findByRole("button", { name: "Other…" });
  const later = slot.getByRole("button", { name: "Later" });
  expect(later.nextElementSibling).toBe(trigger);
  expect(trigger.querySelector("svg[aria-hidden=true]")).not.toBeNull();
  fireEvent.click(trigger);
  const input = slot.getByRole("textbox", { name: "Your answer" });
  expect(document.activeElement).toBe(input);
  expect(slot.queryByRole("button", { name: "Later" })).toBeNull();
  expect(slot.queryByRole("button", { name: "SQLite" })).toBeNull();
  fireEvent.keyDown(input, { key: "Escape" });
  const returned = slot.getByRole("button", { name: "Other…" });
  expect(document.activeElement).toBe(returned);
  fireEvent.click(returned);
  fireEvent.click(slot.getByRole("button", { name: "Cancel" }));
  expect(document.activeElement).toBe(slot.getByRole("button", { name: "Other…" }));
});

test("a rejected typed answer leaves the draft focused in the answer row", async () => {
  let fail!: (error: Error) => void;
  const { slot } = render(CAPTAIN, [decision], {
    resolve: () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
  });
  fireEvent.click(await slot.findByRole("button", { name: "Other…" }));
  const input = slot.getByRole("textbox", { name: "Your answer" }) as HTMLInputElement;
  fireEvent.change(input, { target: { value: "Keep it local" } });
  fireEvent.submit(input.form!);
  expect(input.readOnly).toBe(true);
  expect(document.activeElement).toBe(input);
  await waitFor(() => expect(fail).toBeTypeOf("function"));
  await act(async () => fail(new Error("Try again")));
  await slot.findByText("Try again");
  expect(input.value).toBe("Keep it local");
  expect(input.readOnly).toBe(false);
  expect(document.activeElement).toBe(input);
});

function delayedAnswer() {
  type Acknowledgement = { state: "answered"; warnings: string[] };
  let resolve!: (result: Acknowledgement) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Acknowledgement>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test("refreshing the final ask away keeps focus on the banner through All clear", async () => {
  const response = delayedAnswer();
  let items = [decision];
  const { slot, of } = render(CAPTAIN, () => items, { resolve: () => response.promise });
  fireEvent.click(await slot.findByRole("button", { name: "Other…" }));
  const input = slot.getByRole("textbox", { name: "Your answer" }) as HTMLInputElement;
  fireEvent.change(input, { target: { value: "Use the shared cache" } });
  fireEvent.submit(input.form!);
  await waitFor(() => expect(of("resolveAsk")).toHaveLength(1));
  items = [];
  await slot.experimental_invalidateRpc([asksTag(CAPTAIN)]);
  const status = await slot.findByText("All clear");
  expect(document.activeElement).not.toBe(document.body);
  expect(document.activeElement?.contains(status)).toBe(true);
  await act(async () => response.resolve({ state: "answered", warnings: [] }));
});

test("revisiting a typed answer blocks a second answer until the refreshed queue arrives", async () => {
  const response = delayedAnswer();
  const { slot, of } = render(CAPTAIN, [decision, access], { resolve: () => response.promise });
  fireEvent.click(await slot.findByRole("button", { name: "Other…" }));
  const input = slot.getByRole("textbox", { name: "Your answer" }) as HTMLInputElement;
  fireEvent.change(input, { target: { value: "Read-only for a day" } });
  fireEvent.submit(input.form!);
  await waitFor(() => expect(of("resolveAsk")).toHaveLength(1));
  fireEvent.click(slot.getByRole("tab", { name: /Pick the cache/u }));
  expect(slot.getByRole("button", { name: "SQLite" })).toBeDefined();
  fireEvent.click(slot.getByRole("tab", { name: /Grant the crew/u }));
  expect(slot.queryByRole("button", { name: /Grant read-only/u })).toBeNull();
  await act(async () => response.resolve({ state: "answered", warnings: [] }));
  expect(slot.queryByRole("button", { name: /Grant read-only/u })).toBeNull();
  expect(of("resolveAsk")).toHaveLength(1);
});

test.each(["answered", "failed"] as const)(
  "Other on a second ask stays editable and focused when the first submit is %s",
  async (result) => {
    const response = delayedAnswer();
    const { slot, of } = render(CAPTAIN, [decision, access], {
      resolve: () => response.promise,
    });
    fireEvent.click(await slot.findByRole("button", { name: "Other…" }));
    const first = slot.getByRole("textbox", { name: "Your answer" }) as HTMLInputElement;
    fireEvent.change(first, { target: { value: "Read-only, for one day" } });
    fireEvent.submit(first.form!);
    await waitFor(() => expect(of("resolveAsk")).toHaveLength(1));

    fireEvent.click(slot.getByRole("tab", { name: /Pick the cache/u }));
    fireEvent.click(slot.getByRole("button", { name: "Other…" }));
    const second = slot.getByRole("textbox", { name: "Your answer" }) as HTMLInputElement;
    fireEvent.change(second, { target: { value: "Use the shared cache" } });
    const editableWhileFirstPending = !second.readOnly;
    const canCancelWhileFirstPending = !slot
      .getByRole("button", { name: "Cancel" })
      .hasAttribute("disabled");
    await act(async () => {
      if (result === "failed") response.reject(new Error("Access answer failed"));
      else response.resolve({ state: "answered", warnings: [] });
    });

    expect(document.activeElement).toBe(second);
    expect(second.value).toBe("Use the shared cache");
    expect(slot.queryByText("Access answer failed")).toBeNull();
    expect(editableWhileFirstPending).toBe(true);
    expect(canCancelWhileFirstPending).toBe(true);
  },
);

test("refresh removing the submitting editor restores focus and arms the next ask's shortcuts", async () => {
  const response = delayedAnswer();
  let recorded = false;
  const { slot, of } = render(CAPTAIN, () => [decision, ...(recorded ? [] : [access])], {
    resolve: ({ askId }) =>
      askId === access.id ? response.promise : Promise.resolve({ state: "answered", warnings: [] }),
  });
  fireEvent.click(await slot.findByRole("button", { name: "Other…" }));
  const first = slot.getByRole("textbox", { name: "Your answer" }) as HTMLInputElement;
  fireEvent.change(first, { target: { value: "Read-only, for one day" } });
  fireEvent.submit(first.form!);
  await waitFor(() => expect(of("resolveAsk")).toHaveLength(1));
  recorded = true;
  await slot.experimental_invalidateRpc([asksTag(CAPTAIN)]);
  await waitFor(() => expect(slot.queryByRole("textbox")).toBeNull());

  const next = slot.getByRole("tab", { name: /Pick the cache/u });
  expect(document.activeElement).toBe(next);
  fireEvent.keyDown(next, { key: "2" });
  await waitFor(() =>
    expect(of("resolveAsk").at(-1)?.input).toEqual({ askId: "a1", answer: "SQLite" }),
  );
  await act(async () => response.resolve({ state: "answered", warnings: [] }));
});

test.each([
  { state: "empty", items: [] },
  { state: "populated", items: [decision] },
])("an asks refresh error reports stale status and keeps the $state queue", async ({ items }) => {
  let failing = false;
  const { slot } = render(CAPTAIN, () => {
    if (failing) throw new Error("Asks RPC unavailable");
    return items;
  });
  if (items.length) await slot.findByRole("tab", { name: /Pick the cache/u });
  else await slot.findByText("All clear");

  failing = true;
  await slot.experimental_invalidateRpc([asksTag(CAPTAIN)]);
  const stale = await slot.findByText("Couldn’t refresh asks");
  expect(slot.queryByText("All clear")).toBeNull();
  if (items.length) {
    expect(slot.getByRole("tab", { name: /Pick the cache/u })).toBeDefined();
  } else {
    const icon = stale.parentElement?.querySelector("[data-icon]");
    expect(icon?.getAttribute("data-icon")).toBe("AlertTriangle");
    expect(icon?.className).toContain("text-warning-text");
    expect(stale.className).toContain("font-medium");
  }

  failing = false;
  await slot.experimental_invalidateRpc([asksTag(CAPTAIN)]);
  await waitFor(() => expect(slot.queryByText("Couldn’t refresh asks")).toBeNull());
  if (!items.length) {
    const label = await slot.findByText("All clear");
    expect(label.parentElement?.querySelector("[data-icon]")?.getAttribute("data-icon")).toBe(
      DEFAULT_ICON_GLYPH,
    );
  }
});
