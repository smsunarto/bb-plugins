import { expect, test } from "bun:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../src/server/server.ts";

test("the plugin factory registers a menu service that stops on host shutdown", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "usage-bar",
    dataDir: "/tmp/usage-bar-startup-test",
  });
  const original = process.env.BB_USAGE_BAR_ANY_INSTANCE;
  delete process.env.BB_USAGE_BAR_ANY_INSTANCE;
  try {
    await plugin(bb);
    expect(harness.registrations.services.map(({ name }) => name)).toEqual(["menu-bar"]);
    const service = harness.runService("menu-bar");
    service.controller.abort();
    expect(await service.done.then(() => "stopped")).toBe("stopped");
  } finally {
    await harness.lifecycle.dispose();
    if (original === undefined) delete process.env.BB_USAGE_BAR_ANY_INSTANCE;
    else process.env.BB_USAGE_BAR_ANY_INSTANCE = original;
  }
});
