import { expect, test } from "bun:test";
import { loadPluginApp } from "@get-bb/plugin-sdk/testing/app";

test("Kitchen Sink leaves evidence rendering and provider branding to their owning plugins", async () => {
  const app = await loadPluginApp(() => import("../src/app/app.tsx"));
  expect(app.messageDirectives).toEqual([]);
  expect(app.providerIcons).toEqual([]);
  expect(app.threadHeaderActions.map((row) => row.id)).toContain("thread-details");
});
