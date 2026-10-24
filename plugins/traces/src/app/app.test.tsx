import { expect, test } from "bun:test";
import { loadPluginApp } from "@get-bb/plugin-sdk/testing/app";

test("the thread tab keeps its saved identity as a thread action tab", async () => {
  const app = await loadPluginApp(() => import("./app.tsx"));
  expect(
    app.tabs.map(({ id, context, availability, layout }) => ({
      id,
      context,
      availability,
      layout,
    })),
  ).toEqual([
    { id: "traces", context: { kind: "thread" }, availability: "action", layout: "flush" },
  ]);
  expect(app.navPanels.map(({ id, path }) => ({ id, path }))).toEqual([
    { id: "traces", path: "traces" },
  ]);
});
