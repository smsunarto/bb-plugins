import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, it } from "bun:test";
import type { ExperimentalSidebarNavigationItem } from "@get-bb/plugin-sdk/app";

if (process.env.GTD_CAPY_NAV_TEST_CHILD !== "1") {
  it("CapyNavigation passes the isolated React suite", () => {
    const child = spawnSync(
      process.execPath,
      ["test", "--timeout=30000", fileURLToPath(import.meta.url)],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { ...process.env, GTD_CAPY_NAV_TEST_CHILD: "1" },
        encoding: "utf8",
      },
    );
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  });
} else {
  const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
    JSDOM: new (
      html: string,
      options: { url: string },
    ) => {
      window: Window & typeof globalThis;
    };
  };
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
  });
  for (const name of Object.getOwnPropertyNames(dom.window)) {
    if (name in globalThis) continue;
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: Reflect.get(dom.window, name),
      writable: true,
    });
  }
  const { cleanup, fireEvent } = await import("@testing-library/react");
  const { installTestPluginRuntime, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
  installTestPluginRuntime();
  const { CapyNavigation } = await import("../components/nav/capy-navigation.tsx");

  const item = (
    id: string,
    label: string,
    action: ExperimentalSidebarNavigationItem["action"],
    icon: "new-thread" | "search" | "extensions",
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
  });

  // bb's order: Search sits between New thread and Plugins.
  const ITEMS = [
    item("__bb__/new-thread", "New thread", { kind: "new-thread" }, "new-thread"),
    item("__bb__/search-threads", "Search threads", { kind: "search-threads" }, "search"),
    item("__bb__/extensions", "Plugins", { kind: "open-extensions" }, "extensions"),
  ];

  function mount(items = ITEMS) {
    return renderSlot(
      { component: CapyNavigation },
      { isCompactViewport: false, placement: "list", experimental_Original: () => null },
      { sidebarNavigation: { items, activeItemId: null } },
    );
  }

  afterEach(() => {
    cleanup();
  });

  afterAll(() => {
    dom.window.close();
  });

  describe("CapyNavigation", () => {
    it("draws Search as a row, in the order bb gives it", () => {
      const slot = mount();
      const rows = [...slot.container.querySelectorAll("[data-sidebar-navigation-item]")].map(
        (row) => row.getAttribute("data-sidebar-navigation-item"),
      );
      assert.deepEqual(rows, ["__bb__/new-thread", "__bb__/search-threads", "__bb__/extensions"]);
    });

    it("opens search when its row is clicked", () => {
      const slot = mount();
      fireEvent.click(slot.getByRole("button", { name: "Search threads" }));
      assert.deepEqual(slot.inspection.sidebarNavigationCalls, [
        { method: "activate", itemId: "__bb__/search-threads", target: "current" },
      ]);
    });

    it("keeps a hidden Search under More", () => {
      const search = { ...ITEMS[1]!, isVisible: false };
      const hidden = [ITEMS[0]!, search, ITEMS[2]!];
      const slot = mount(hidden);
      assert.equal(slot.queryByRole("button", { name: "Search threads" }), null);
      assert.ok(slot.getByRole("button", { name: "More" }));
    });
  });
}
