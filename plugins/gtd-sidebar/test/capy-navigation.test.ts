import assert from "node:assert/strict";
import { afterEach, describe, it } from "bun:test";
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
  } = {},
  isCompactViewport = false,
  coarsePointer = isCompactViewport,
): ReturnType<typeof renderSlot> {
  const { plugins, ...sidebarNavigation } = options;
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
        plugins: {
          list: async () => ({ plugins: plugins ?? [] }) as never,
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
      "renders beside New thread and Search on compact=%s when Captain runs and opens New Captain",
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
              NEW_CAPTAIN_NAV_ITEM_ID,
              SEARCH,
              "__bb__/extensions",
            ]),
          );
          fireEvent.click(button);
          assert.equal(opened, 1);
        } finally {
          forgetSidebarActions(published);
        }
      },
    );
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
