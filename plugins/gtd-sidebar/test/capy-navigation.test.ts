import assert from "node:assert/strict";
import { afterEach, describe, it, spyOn } from "bun:test";
import type { ExperimentalSidebarNavigationItem } from "@get-bb/plugin-sdk/app";
import { installDom } from "@bb-plugins/testing";

installDom();
const { act, cleanup, fireEvent, waitFor } = await import("@testing-library/react");
const { installTestPluginRuntime, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
installTestPluginRuntime();
const { CapyNavigation, NEW_CAPTAIN_NAV_ITEM_ID } =
  await import("../components/nav/capy-navigation.tsx");
const { forgetSidebarActions, publishSidebarActions } =
  await import("../lib/sidebar-actions-bridge.ts");
const { disposeCaptainAvailability } = await import("../hooks/use-captain.ts");

const SEARCH = "__bb__/search-threads";
const originalMatchMedia = window.matchMedia;

const item = (
  id: string,
  label: string,
  action: ExperimentalSidebarNavigationItem["action"],
  icon: "new-thread" | "search" | "extensions",
  overrides: Partial<ExperimentalSidebarNavigationItem> = {},
): ExperimentalSidebarNavigationItem => ({
  id,
  label,
  icon: { kind: "host", name: icon },
  action,
  isDisabled: false,
  isVisible: true,
  isLoading: false,
  pluginId: null,
  shortcut: null,
  badge: null,
  ...overrides,
});

/** bb's order: Search sits between New thread and Plugins. */
function items(
  search: Partial<ExperimentalSidebarNavigationItem> = {},
  plugins: Partial<ExperimentalSidebarNavigationItem> = {},
) {
  return [
    item("__bb__/new-thread", "New thread", { kind: "new-thread" }, "new-thread"),
    item(SEARCH, "Search threads", { kind: "search-threads" }, "search", search),
    item("__bb__/extensions", "Plugins", { kind: "open-extensions" }, "extensions", plugins),
  ];
}

function mount(
  list = items(),
  options: {
    isShortcutModifierHeld?: boolean;
    activeItemId?: string | null;
    plugins?: readonly { id: string; enabled: boolean; status: string }[];
    listPlugins?: () => Promise<{
      plugins: readonly { id: string; enabled: boolean; status: string }[];
    }>;
    subscribe?: (args: { event: string; callback: (event: unknown) => void }) => () => void;
  } = {},
  isCompactViewport = false,
  coarsePointer = isCompactViewport,
): ReturnType<typeof renderSlot> {
  const { plugins, listPlugins, subscribe, ...sidebarNavigation } = options;
  window.matchMedia = (query) => ({
    media: query,
    matches: coarsePointer && query === "(pointer: coarse)",
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
  });
  return renderSlot(
    { component: CapyNavigation },
    { isCompactViewport, placement: "list", experimental_Original: () => null },
    {
      sidebarNavigation: { items: list, activeItemId: null, ...sidebarNavigation },
      sdk: {
        subscribe: (subscribe ?? (() => () => {})) as never,
        plugins: {
          list: (listPlugins ?? (async () => ({ plugins: plugins ?? [] }))) as never,
        },
      },
    },
  );
}

const rowIds = (slot: ReturnType<typeof mount>) =>
  [...slot.container.querySelectorAll("[data-sidebar-navigation-item]")].map((row) =>
    row.getAttribute("data-sidebar-navigation-item"),
  );

afterEach(() => {
  cleanup();
  window.matchMedia = originalMatchMedia;
});

describe("CapyNavigation", () => {
  it("draws Search as a row, in the order bb gives it", () => {
    assert.deepEqual(rowIds(mount()), ["__bb__/new-thread", SEARCH, "__bb__/extensions"]);
  });

  it("opens search when its row is clicked", () => {
    const slot = mount();
    fireEvent.click(slot.getByRole("button", { name: "Search threads" }));
    assert.deepEqual(slot.inspection.sidebarNavigationCalls, [
      { method: "activate", itemId: SEARCH, target: "current" },
    ]);
  });

  it("moves Search under More when navigation settings hide it, like any item", () => {
    const slot = mount(items({ isVisible: false }, { isVisible: false }));
    assert.deepEqual(rowIds(slot), ["__bb__/new-thread"]);
    fireEvent.keyDown(slot.getByRole("button", { name: "More" }), { key: "Enter" });
    const menu = slot.getAllByRole("menuitem").map((entry) => entry.textContent);
    assert.deepEqual(menu, ["Search threads", "Plugins", "Customize navigation…"]);
    fireEvent.click(slot.getByRole("menuitem", { name: "Search threads" }));
    assert.deepEqual(slot.inspection.sidebarNavigationCalls, [
      { method: "activate", itemId: SEARCH, target: "current" },
    ]);
  });

  it("draws no More row while every item is visible", () => {
    assert.equal(mount().queryByRole("button", { name: "More" }), null);
  });

  it("spaces desktop navigation rows and More evenly with gap-1, matching the thread list", () => {
    const desktop = mount(items({}, { isVisible: false }), {}, false);
    const nav = desktop.getByRole("navigation");
    const scroller = nav.querySelector("[data-gtd-nav-scroll]");
    assert.ok(nav.className.split(/\s+/).includes("gap-1"));
    assert.ok(scroller?.className.split(/\s+/).includes("gap-1"));
    cleanup();

    const phone = mount(items({}, { isVisible: false }), {}, true);
    const phoneNav = phone.getByRole("navigation");
    const phoneScroller = phoneNav.querySelector("[data-gtd-nav-scroll]");
    assert.equal(phoneNav.className.split(/\s+/).includes("gap-1"), false);
    assert.equal(phoneScroller?.className.split(/\s+/).includes("gap-1"), false);
  });

  it("keeps More outside the phone rows' scroll region", () => {
    const slot = mount(items({}, { isVisible: false }), {}, true);
    const nav = slot.getByRole("navigation");
    const scroller = nav.querySelector("[data-gtd-nav-scroll]");
    assert.ok(scroller);
    assert.ok(scroller.querySelector(`[data-sidebar-navigation-item="${SEARCH}"]`));
    assert.equal(scroller.nextElementSibling, slot.getByRole("button", { name: "More" }));
  });

  it("leaves phone styling out of compact mouse navigation", () => {
    const slot = mount(items(), {}, true, false);
    const nav = slot.getByRole("navigation");
    assert.equal(nav.hasAttribute("data-gtd-phone-nav"), false);
    assert.ok(nav.className.split(/\s+/).includes("gap-1"));
  });

  it("starts phone navigation directly with the scrolling rows", () => {
    const slot = mount(items(), {}, true);
    const nav = slot.getByRole("navigation");
    assert.equal(nav.hasAttribute("data-gtd-phone-nav"), true);
    assert.equal(nav.firstElementChild?.hasAttribute("data-gtd-nav-scroll"), true);
    assert.equal(nav.children.length, 1);
  });

  it("shows Search's shortcut while the modifier is held", () => {
    const search = { shortcut: { label: "Ctrl K", ariaKeyShortcuts: "Control+K" } };
    const row = (held: boolean) => {
      const slot = mount(items(search), { isShortcutModifierHeld: held });
      const button = slot.getByRole("button", { name: /^Search threads/ });
      const result = {
        text: button.textContent,
        keys: button.getAttribute("aria-keyshortcuts"),
      };
      cleanup();
      return result;
    };
    assert.deepEqual(row(true), { text: "Search threadsCtrl K", keys: "Control+K" });
    assert.deepEqual(row(false), { text: "Search threads", keys: "Control+K" });
  });

  describe("New Captain entry", () => {
    const CAPTAIN_RUNNING = [{ id: "captain", enabled: true, status: "running" }];

    it("does not render when Captain is absent or disabled", async () => {
      const absent = mount();
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      assert.equal(absent.queryByRole("button", { name: "New Captain" }), null);
      cleanup();

      const disabled = mount(items(), {
        plugins: [{ id: "captain", enabled: false, status: "disabled" }],
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      assert.equal(disabled.queryByRole("button", { name: "New Captain" }), null);
    });

    it("does not render when Captain runs without a mounted inbox handler", async () => {
      const slot = mount(items(), { plugins: CAPTAIN_RUNNING });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      assert.equal(slot.queryByRole("button", { name: "New Captain" }), null);
    });

    it.each([false, true])(
      "renders at the end of visible rows on compact=%s when Captain runs and opens New Captain",
      async (compact) => {
        let opened = 0;
        const published = {
          settle() {},
          canSettle: () => false,
          openNewCaptain: () => {
            opened += 1;
          },
        };
        publishSidebarActions(published);
        try {
          const slot = mount(items(), { plugins: CAPTAIN_RUNNING }, compact, compact);
          const button = await slot.findByRole("button", { name: "New Captain" });
          await waitFor(() =>
            assert.deepEqual(rowIds(slot), [
              "__bb__/new-thread",
              SEARCH,
              "__bb__/extensions",
              NEW_CAPTAIN_NAV_ITEM_ID,
            ]),
          );
          fireEvent.click(button);
          assert.equal(opened, 1);
        } finally {
          forgetSidebarActions(published);
        }
      },
    );

    it("renders New Captain even when New thread is hidden", async () => {
      const published = { settle() {}, canSettle: () => false, openNewCaptain() {} };
      publishSidebarActions(published);
      try {
        const list = [
          item("__bb__/new-thread", "New thread", { kind: "new-thread" }, "new-thread", {
            isVisible: false,
          }),
          item(SEARCH, "Search threads", { kind: "search-threads" }, "search"),
          item("__bb__/extensions", "Plugins", { kind: "open-extensions" }, "extensions"),
        ];
        const slot = mount(list, { plugins: CAPTAIN_RUNNING });
        await slot.findByRole("button", { name: "New Captain" });
        assert.deepEqual(rowIds(slot), [SEARCH, "__bb__/extensions", NEW_CAPTAIN_NAV_ITEM_ID]);
      } finally {
        forgetSidebarActions(published);
      }
    });

    it("hides the row when a refresh times out and recovers on plugins-changed and real reconnect", async () => {
      const published = { settle() {}, canSettle: () => false, openNewCaptain() {} };
      publishSidebarActions(published);
      const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
      const timeoutSpy = spyOn(AbortSignal, "timeout").mockImplementation(() =>
        originalTimeout(20),
      );
      const handlers = new Map<string, Set<(event: unknown) => void>>();
      const emit = (eventName: string, payload: unknown) => {
        for (const cb of handlers.get(eventName) ?? []) cb(payload);
      };
      const subscribe = ({
        event,
        callback,
      }: {
        event: string;
        callback: (e: unknown) => void;
      }) => {
        const set = handlers.get(event) ?? new Set();
        set.add(callback);
        handlers.set(event, set);
        return () => set.delete(callback);
      };
      let calls = 0;
      let mode: "hang" | "running" | "disabled" = "running";
      const listPlugins = () => {
        calls += 1;
        if (mode === "hang") return new Promise<never>(() => {});
        if (mode === "disabled") {
          return Promise.resolve({
            plugins: [{ id: "captain", enabled: false, status: "disabled" }],
          });
        }
        return Promise.resolve({ plugins: CAPTAIN_RUNNING });
      };
      try {
        const slot = mount(items(), { listPlugins, subscribe });
        await slot.findByRole("button", { name: "New Captain" });
        assert.equal(calls, 1);

        // First connect is not a reconnect and must not trigger a re-read.
        act(() => {
          emit("realtime:connection", {
            state: "connecting",
            reconnected: false,
            reconnectDelayMs: null,
          });
          emit("realtime:connection", {
            state: "connected",
            reconnected: false,
            reconnectDelayMs: null,
          });
        });
        assert.equal(calls, 1);

        // Make plugins.list hang on refresh: the 20ms timeout must clear the visible row.
        mode = "hang";
        act(() =>
          emit("system:changed", {
            entity: "system",
            type: "changed",
            changes: ["plugins-changed"],
          }),
        );
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 60));
        });
        assert.equal(slot.queryByRole("button", { name: "New Captain" }), null);

        // plugins-changed recovers it.
        mode = "running";
        act(() =>
          emit("system:changed", {
            entity: "system",
            type: "changed",
            changes: ["plugins-changed"],
          }),
        );
        await slot.findByRole("button", { name: "New Captain" });

        // plugins-changed hides it, then a real reconnect restores it.
        mode = "disabled";
        act(() =>
          emit("system:changed", {
            entity: "system",
            type: "changed",
            changes: ["plugins-changed"],
          }),
        );
        await waitFor(() =>
          assert.ok(slot.queryByRole("button", { name: "New Captain" }) === null),
        );

        mode = "running";
        act(() =>
          emit("realtime:connection", {
            state: "disconnected",
            reconnected: false,
            reconnectDelayMs: 500,
          }),
        );
        act(() =>
          emit("realtime:connection", {
            state: "connected",
            reconnected: false,
            reconnectDelayMs: null,
          }),
        );
        await slot.findByRole("button", { name: "New Captain" });
      } finally {
        timeoutSpy.mockRestore();
        forgetSidebarActions(published);
      }
    });

    it("unsubscribes listeners on bundle dispose so reload triggers one read per event and disable triggers none", async () => {
      const published = { settle() {}, canSettle: () => false, openNewCaptain() {} };
      publishSidebarActions(published);
      const handlers = new Map<string, Set<(event: unknown) => void>>();
      const emit = (eventName: string, payload: unknown) => {
        for (const cb of handlers.get(eventName) ?? []) cb(payload);
      };
      const subscribe = ({
        event,
        callback,
      }: {
        event: string;
        callback: (e: unknown) => void;
      }) => {
        const set = handlers.get(event) ?? new Set();
        set.add(callback);
        handlers.set(event, set);
        return () => set.delete(callback);
      };
      let calls = 0;
      const listPlugins = async () => {
        calls += 1;
        return { plugins: CAPTAIN_RUNNING };
      };
      try {
        // Generation 1 mounts, then disposes on simulated bundle swap.
        const first = mount(items(), { listPlugins, subscribe });
        await first.findByRole("button", { name: "New Captain" });
        assert.equal(calls, 1);
        disposeCaptainAvailability();
        cleanup();

        // Generation 2 mounts on the same event bus: one plugins-changed event triggers one read.
        const second = mount(items(), { listPlugins, subscribe });
        await second.findByRole("button", { name: "New Captain" });
        assert.equal(calls, 2);
        act(() =>
          emit("system:changed", {
            entity: "system",
            type: "changed",
            changes: ["plugins-changed"],
          }),
        );
        await act(async () => {});
        assert.equal(calls, 3);

        // After plugin disable / dispose, events trigger zero reads.
        disposeCaptainAvailability();
        cleanup();
        act(() => {
          emit("system:changed", {
            entity: "system",
            type: "changed",
            changes: ["plugins-changed"],
          });
          emit("realtime:connection", {
            state: "disconnected",
            reconnected: false,
            reconnectDelayMs: 500,
          });
          emit("realtime:connection", {
            state: "connected",
            reconnected: true,
            reconnectDelayMs: null,
          });
        });
        await act(async () => {});
        assert.equal(calls, 3);
      } finally {
        forgetSidebarActions(published);
      }
    });
  });

  describe("phone scrolling", () => {
    /** bb's page that the drawer slides aside, with the drawer's state. */
    function inset(shelf: "open" | "closed") {
      const element = document.createElement("main");
      element.setAttribute("data-sidebar", "inset");
      element.setAttribute("data-sidebar-shelf", shelf);
      document.body.append(element);
      return element;
    }

    /** jsdom lays nothing out: give the region a scroll position and rows a place. */
    let height = 50;

    function layout(slot: ReturnType<typeof mount>) {
      height = 50;
      const region = slot.container.querySelector<HTMLElement>("[data-gtd-nav-scroll]")!;
      let top = 0;
      Object.defineProperty(region, "scrollTop", {
        get: () => top,
        set: (v) => {
          top = v;
        },
      });
      Object.defineProperty(region, "clientHeight", { get: () => height });
      Object.defineProperty(region, "scrollHeight", { get: () => region.children.length * 44 });
      for (const [index, row] of [...region.children].entries()) {
        Object.defineProperty(row, "offsetTop", { value: index * 44 });
        Object.defineProperty(row, "offsetHeight", { value: 44 });
      }
      return region;
    }

    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

    afterEach(() => {
      document.querySelector('[data-sidebar="inset"]')?.remove();
    });

    it("resets the rows when the drawer closes, showing the active row", async () => {
      const page = inset("open");
      const slot = mount(items(), { activeItemId: SEARCH }, true);
      const region = layout(slot);
      region.scrollTop = 40;
      await frame();
      assert.equal(region.scrollTop, 40, "an open drawer keeps a scroll that shows the active row");
      page.setAttribute("data-sidebar-shelf", "closed");
      await frame();
      await frame();
      // Search is the second row: its bottom (88px) less the 50px region.
      assert.equal(region.scrollTop, 38);
    });

    it("brings the active row back into view when the drawer opens after a resize", async () => {
      const page = inset("closed");
      const slot = mount(items(), { activeItemId: "__bb__/extensions" }, true);
      const region = layout(slot);
      height = 200;
      page.setAttribute("data-sidebar-shelf", "closed");
      await frame();
      await frame();
      assert.equal(region.scrollTop, 0, "all three rows fit the tall drawer");
      // The screen shrinks while the drawer is closed; nothing re-places it.
      height = 50;
      page.setAttribute("data-sidebar-shelf", "open");
      await frame();
      await frame();
      // Plugins is the third row: its bottom (132px) less the 50px region.
      assert.equal(region.scrollTop, 82);
    });

    it("leaves an open drawer's scroll alone while the active row is in view", async () => {
      const page = inset("closed");
      const slot = mount(items(), { activeItemId: "__bb__/new-thread" }, true);
      const region = layout(slot);
      await frame();
      page.setAttribute("data-sidebar-shelf", "open");
      await frame();
      await frame();
      assert.equal(region.scrollTop, 0);
    });

    it("returns to the top when the active item has no row", async () => {
      const page = inset("open");
      const region = layout(mount(items(), {}, true));
      region.scrollTop = 30;
      page.setAttribute("data-sidebar-shelf", "closed");
      await frame();
      await frame();
      assert.equal(region.scrollTop, 0);
    });

    it("leaves desktop alone", async () => {
      inset("closed");
      const region = layout(mount(items(), { activeItemId: "__bb__/extensions" }, false));
      region.scrollTop = 30;
      await frame();
      assert.equal(region.scrollTop, 30);
    });

    it("marks rows below initially and clears the fade flag at the end", async () => {
      const region = layout(mount(items(), {}, true));
      await frame();
      assert.equal(region.hasAttribute("data-gtd-nav-more-below"), true);
      region.scrollTop = region.scrollHeight - region.clientHeight;
      fireEvent.scroll(region);
      assert.equal(region.hasAttribute("data-gtd-nav-more-below"), false);
    });

    it("scrolls a focused row into view and marks a scrolled region", () => {
      const slot = mount(items(), {}, true);
      const region = layout(slot);
      const plugins = slot.getByRole("button", { name: "Plugins" });
      const calls: unknown[] = [];
      plugins.scrollIntoView = (options) => calls.push(options);
      fireEvent.focus(plugins);
      assert.deepEqual(calls, [{ block: "nearest" }]);
      region.scrollTop = 20;
      fireEvent.scroll(region);
      assert.equal(region.hasAttribute("data-gtd-nav-scrolled"), true);
      region.scrollTop = 0;
      fireEvent.scroll(region);
      assert.equal(region.hasAttribute("data-gtd-nav-scrolled"), false);
    });
  });
});
