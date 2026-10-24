// @vitest-environment jsdom
import { loadPluginApp } from "@get-bb/plugin-sdk/testing/app";
import { expect, it } from "vitest";
import { PANEL_ACTION_ID } from "../shared/contracts/panel.ts";

it("registers the thread tab under the id saved tabs and the server's tab writer use", async () => {
  const app = await loadPluginApp(() => import("./app.tsx"));
  expect(
    app.tabs.map(({ id, context, availability, layout }) => ({
      id,
      context,
      availability,
      layout,
    })),
  ).toEqual([
    { id: PANEL_ACTION_ID, context: { kind: "thread" }, availability: "action", layout: "flush" },
  ]);
  expect(app.tabs[0]?.id).toBe("whiteboard");
});
