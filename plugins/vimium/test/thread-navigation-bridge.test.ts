import "./helpers/dom.ts";
import "./helpers/bb-keybindings.ts";
import { afterEach, describe, expect, test } from "bun:test";
import type { PluginContentScriptContext } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { CHEATSHEET } from "../src/app/cheatsheet.ts";
import { mountLinkHints, setBbNavigation } from "../src/app/link-hints.ts";

function pressKey(key: string, repeat = false): boolean {
  // A browser reports `?` with Shift held, and bb matches it as Shift+/.
  const shiftKey = key === "?";
  return window.dispatchEvent(
    new KeyboardEvent("keydown", { key, shiftKey, repeat, bubbles: true, cancelable: true }),
  );
}

afterEach(() => {
  setBbNavigation(null);
  document.body.innerHTML = "";
  window.history.pushState({}, "", "/");
});

describe("thread navigation overlay", () => {
  test("opens a windowed-out sidebar row through bb's navigation while mounted", async () => {
    const app = await loadPluginApp(() => import("../src/app/app.tsx"));
    const overlay = app.appOverlays.find(({ id }) => id === "thread-navigation");
    expect(overlay).toBeDefined();
    const slot = renderSlot(overlay!, {});

    const controller = new window.AbortController();
    const context: PluginContentScriptContext = {
      pluginId: "vimium",
      generation: 1,
      signal: controller.signal,
    };
    const dispose = mountLinkHints(context);
    // The row after thr_1 is windowed out of the list: no link to click.
    document.body.innerHTML =
      '<a data-sidebar-thread-id="thr_1" data-sidebar-thread-shortcut-target href="#">One</a>' +
      '<div data-sidebar-windowed-nav="thr_2:proj_a"></div>';
    window.history.pushState({}, "", "/threads/thr_1");

    expect(pressKey("]")).toBe(false);
    expect(slot.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "thr_2" }]);

    // Unmounted, the overlay takes its opener with it.
    slot.lifecycle.unmount();
    pressKey("]");
    expect(slot.inspection.navigateCalls).toHaveLength(1);

    void dispose();
    controller.abort();
  });

  test("? opens the cheatsheet page, which lists every section", async () => {
    const app = await loadPluginApp(() => import("../src/app/app.tsx"));
    const overlay = app.appOverlays.find(({ id }) => id === "thread-navigation")!;
    const slot = renderSlot(overlay, {});
    const controller = new window.AbortController();
    const dispose = mountLinkHints({
      pluginId: "vimium",
      generation: 1,
      signal: controller.signal,
    });

    expect(pressKey("?")).toBe(false);
    // Holding the key does not push the page again.
    pressKey("?", true);
    // On the page, `?` replaces its entry instead of stacking one.
    window.history.pushState({}, "", "/plugins/vimium/cheatsheet");
    pressKey("?");
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "toPluginPanel", path: "cheatsheet", options: { replace: false } },
      { method: "toPluginPanel", path: "cheatsheet", options: { replace: true } },
    ]);

    const panel = app.navPanels.find(({ path }) => path === "cheatsheet")!;
    const shortcut = { key: "/", shift: true, mod: false, meta: false, control: false, alt: false };
    const page = renderSlot(
      panel,
      { subPath: "" },
      {
        pluginId: "vimium",
        sdk: {
          system: {
            config: async () => ({
              keybindingOverrides: [{ command: "plugin:vimium/cheatsheet", shortcut }],
            }),
          },
        } as never,
      },
    );
    for (const section of CHEATSHEET) {
      expect(page.getByRole("heading", { name: section.title })).toBeDefined();
    }
    // Bound commands show the user's keys; the rest say so.
    const row = await page.findByText("Open the Vimium cheatsheet");
    expect(row.previousElementSibling?.textContent).toBe("?");
    const branch = page.getByText("Open the branch picker");
    expect(branch.previousElementSibling?.textContent).toBe("Unbound");

    page.lifecycle.unmount();
    slot.lifecycle.unmount();
    void dispose();
    controller.abort();
  });
});
