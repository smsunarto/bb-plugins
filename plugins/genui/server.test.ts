import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "./server";

describe("the plugin's settings", () => {
  it("lists Animations, on by default, beside Web lookups", async () => {
    const host = createFakePluginHost({ pluginId: "genui" });
    await plugin(host.bb);
    expect(host.harness.registrations.settingsDescriptors).toMatchObject({
      animations: { type: "boolean", label: "Animations", default: true },
      webLookups: { type: "boolean", label: "Web lookups", default: true },
    });
  });
});
