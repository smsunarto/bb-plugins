// @vitest-environment jsdom
import { cleanup, fireEvent } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("./app"));
const toggle = app.composerCustomizations[0]?.actions?.[0];
if (toggle === undefined) throw new Error("Magic Compose must register its composer toggle");

// The wand asks whether motion is reduced; jsdom has no matchMedia.
Object.defineProperty(window, "matchMedia", {
  configurable: true,
  writable: true,
  value: (media: string) => ({
    matches: false,
    media,
    addEventListener() {},
    removeEventListener() {},
  }),
});

afterEach(cleanup);

it("lights the wand with the toggle before the preferences have loaded", () => {
  const slot = renderSlot(
    { component: toggle.component },
    {},
    {
      composer: { scope: { kind: "new-thread", projectId: "project-1" } },
      rpc: {
        // Still on their way: Magic Compose does not act until it has read them.
        preferencesGet: () => new Promise(() => {}),
        warm: () => ({ warmed: true }),
      },
    },
  );
  const button = slot.getByRole("button", { name: "Magic Compose" });
  const wand = () => button.querySelector("svg")?.dataset.state;
  expect(button.getAttribute("aria-pressed")).toBe("false");
  expect(wand()).toBe("off");

  fireEvent.click(button);
  expect(button.getAttribute("aria-pressed")).toBe("true");
  expect(wand()).toBe("on");

  fireEvent.click(button);
  expect(button.getAttribute("aria-pressed")).toBe("false");
  expect(wand()).toBe("off");
});
