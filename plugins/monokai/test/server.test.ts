import { describe, expect, test } from "bun:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";

import plugin from "../server.ts";

describe("bb Monokai UI font setting", () => {
  test("declares Inter as the default and SF Pro as the alternative", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "monokai" });
    await plugin(bb);

    expect(harness.registrations.settingsDescriptors).toEqual({
      uiFont: {
        type: "select",
        label: "UI font",
        description:
          "Applies to the full bb interface on mobile and desktop. Code keeps Berkeley Mono.",
        options: ["Inter (Default)", "SF Pro"],
        default: "Inter (Default)",
      },
    });

    await harness.lifecycle.dispose();
  });

  test("serves the current font to open clients", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "monokai" });
    await plugin(bb);

    const initial = await harness.behavior.callRpc("getUiFont", {});
    expect(initial).toEqual({ uiFont: "Inter (Default)" });

    await harness.behavior.setSettings({ uiFont: "SF Pro" });
    expect(await harness.behavior.callRpc("getUiFont", {})).toEqual({ uiFont: "SF Pro" });

    await harness.lifecycle.dispose();
  });
});
