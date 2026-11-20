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
  options: { isShortcutModifierHeld?: boolean } = {},
): ReturnType<typeof renderSlot> {
  return renderSlot(
    { component: CapyNavigation },
    { isCompactViewport: false, placement: "list", experimental_Original: () => null },
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

  it("keeps the Search row when navigation settings hide it", () => {
    const slot = mount(items({ isVisible: false }));
    assert.deepEqual(rowIds(slot), ["__bb__/new-thread", SEARCH, "__bb__/extensions"]);
    assert.equal(slot.queryByRole("button", { name: "More" }), null);
  });

  it("moves other hidden items under More, and never Search", () => {
    const slot = mount(items({ isVisible: false }, { isVisible: false }));
    assert.deepEqual(rowIds(slot), ["__bb__/new-thread", SEARCH]);
    fireEvent.keyDown(slot.getByRole("button", { name: "More" }), { key: "Enter" });
    const menu = slot.getAllByRole("menuitem").map((entry) => entry.textContent);
    assert.deepEqual(menu, ["Plugins", "Customize navigation…"]);
    fireEvent.click(slot.getByRole("menuitem", { name: "Plugins" }));
    assert.deepEqual(slot.inspection.sidebarNavigationCalls, [
      { method: "activate", itemId: "__bb__/extensions", target: "current" },
    ]);
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
});
