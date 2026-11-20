import assert from "node:assert/strict";
import { afterEach, describe, it } from "bun:test";
import type { ExperimentalSidebarNavigationItem } from "@get-bb/plugin-sdk/app";
import { installDom } from "@bb-plugins/testing";

installDom();
const { cleanup, fireEvent } = await import("@testing-library/react");
const { installTestPluginRuntime, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
installTestPluginRuntime();
const { CapyNavigation } = await import("../components/nav/capy-navigation.tsx");

const SEARCH = "__bb__/search-threads";

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
  options: { isShortcutModifierHeld?: boolean; activeItemId?: string | null } = {},
  isCompactViewport = false,
): ReturnType<typeof renderSlot> {
  return renderSlot(
    { component: CapyNavigation },
    { isCompactViewport, placement: "list", experimental_Original: () => null },
    { sidebarNavigation: { items: list, activeItemId: null, ...options } },
  );
}

const rowIds = (slot: ReturnType<typeof mount>) =>
  [...slot.container.querySelectorAll("[data-sidebar-navigation-item]")].map((row) =>
    row.getAttribute("data-sidebar-navigation-item"),
  );

afterEach(() => {
  cleanup();
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

  it("keeps More outside the rows' scrolling region", () => {
    const slot = mount(items({}, { isVisible: false }));
    const more = slot.getByRole("button", { name: "More" });
    const region = slot.getByRole("button", { name: "Search threads" }).parentElement!;
    assert.equal(region.contains(more), false);
    assert.equal(region.parentElement, more.parentElement);
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
    function layout(slot: ReturnType<typeof mount>) {
      const region = slot.getByRole("button", { name: "Search threads" }).parentElement!;
      let top = 0;
      Object.defineProperty(region, "scrollTop", {
        get: () => top,
        set: (v) => {
          top = v;
        },
      });
      Object.defineProperty(region, "clientHeight", { value: 50 });
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
      const slot = mount(items(), { activeItemId: "__bb__/extensions" }, true);
      const region = layout(slot);
      region.scrollTop = 7;
      await frame();
      assert.equal(region.scrollTop, 7, "an open drawer keeps its scroll");
      page.setAttribute("data-sidebar-shelf", "closed");
      await frame();
      await frame();
      // Plugins is the third row: its bottom (132px) less the 50px region.
      assert.equal(region.scrollTop, 82);
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
