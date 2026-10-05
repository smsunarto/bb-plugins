import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createSettings, RELOAD_DEBOUNCE_MS, whenSettingsLoaded } from "./settings.ts";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function setup(stored: Record<string, boolean> = {}) {
  const { bb, harness } = createFakePluginHost({
    pluginId: "whiteboard",
    settings: stored,
    sdk: { plugins: { reload: async () => ({ ok: true }) } },
  });
  const settings = createSettings(bb);
  return { bb, harness, settings, reloads: () => harness.sdk.callsTo("plugins.reload") };
}

describe("settings", () => {
  test("both default to off", async () => {
    const { settings } = setup();
    await whenSettingsLoaded(settings);
    expect([settings.scratchpadEnabled(), settings.softwareMapEnabled()]).toEqual([false, false]);
  });

  test("stored values are read once loaded", async () => {
    const { settings } = setup({ scratchpadEnabled: true, softwareMapEnabled: true });
    await whenSettingsLoaded(settings);
    expect([settings.scratchpadEnabled(), settings.softwareMapEnabled()]).toEqual([true, true]);
  });

  test("bb lists them with upstream's labels, in upstream's order", () => {
    const { harness } = setup();
    const descriptors = harness.registrations.settingsDescriptors;
    expect(Object.keys(descriptors)).toEqual(["softwareMapEnabled", "scratchpadEnabled"]);
    expect(descriptors).toEqual({
      softwareMapEnabled: {
        type: "boolean",
        label: "Software Map",
        description: "Show the experimental Software Map view in Whiteboards.",
        default: false,
      },
      scratchpadEnabled: {
        type: "boolean",
        label: "Scratchpad",
        description:
          "Show the experimental scratchpad on Home. Agents draw on it through Whiteboard's MCP tools.",
        default: false,
      },
    });
  });
});

describe("a change", () => {
  test("notifies subscribers and publishes whiteboard:settings", async () => {
    const { harness, settings } = setup();
    await whenSettingsLoaded(settings);
    const seen: unknown[] = [];
    const unsubscribe = settings.subscribe((next, previous) => seen.push({ next, previous }));
    await harness.setSettings({ softwareMapEnabled: true });
    unsubscribe();
    await harness.setSettings({ softwareMapEnabled: false });
    expect(settings.softwareMapEnabled()).toBe(false);
    expect(seen).toEqual([
      {
        next: { scratchpadEnabled: false, softwareMapEnabled: true },
        previous: { scratchpadEnabled: false, softwareMapEnabled: false },
      },
    ]);
    expect(harness.realtimeSignals).toEqual([
      {
        channel: "whiteboard:settings",
        payload: { scratchpadEnabled: false, softwareMapEnabled: true },
      },
      {
        channel: "whiteboard:settings",
        payload: { scratchpadEnabled: false, softwareMapEnabled: false },
      },
    ]);
  });

  test("to the scratchpad reloads this plugin once, after the quiet period", async () => {
    const { harness, settings, reloads } = setup();
    await whenSettingsLoaded(settings);
    await harness.setSettings({ scratchpadEnabled: true });
    await harness.setSettings({ scratchpadEnabled: false });
    await harness.setSettings({ scratchpadEnabled: true });
    expect(settings.scratchpadEnabled()).toBe(true);
    await vi.advanceTimersByTimeAsync(RELOAD_DEBOUNCE_MS - 1);
    expect(reloads()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(reloads()).toEqual([[{ pluginId: "whiteboard" }]]);
  });

  test("to the Software Map only never reloads", async () => {
    const { harness, settings, reloads } = setup();
    await whenSettingsLoaded(settings);
    await harness.setSettings({ softwareMapEnabled: true });
    await vi.advanceTimersByTimeAsync(RELOAD_DEBOUNCE_MS * 4);
    expect(reloads()).toEqual([]);
  });

  test("a failed reload is logged, not thrown", async () => {
    const { harness, settings } = setup();
    harness.sdk.stub("plugins.reload", async () => {
      throw new Error("busy");
    });
    await whenSettingsLoaded(settings);
    await harness.setSettings({ scratchpadEnabled: true });
    await vi.advanceTimersByTimeAsync(RELOAD_DEBOUNCE_MS);
    expect(harness.logEntries).toEqual([
      {
        level: "warn",
        message: "whiteboard: reload after the scratchpad change failed: Error: busy",
      },
    ]);
  });

  test("disposing cancels a pending reload", async () => {
    const { harness, settings, reloads } = setup();
    await whenSettingsLoaded(settings);
    await harness.setSettings({ scratchpadEnabled: true });
    await harness.dispose();
    await vi.advanceTimersByTimeAsync(RELOAD_DEBOUNCE_MS * 2);
    expect(reloads()).toEqual([]);
  });

  test("a listener that throws does not stop the publish or the reload", async () => {
    const { harness, settings, reloads } = setup();
    await whenSettingsLoaded(settings);
    settings.subscribe(() => {
      throw new Error("listener broke");
    });
    await harness.setSettings({ scratchpadEnabled: true });
    await vi.advanceTimersByTimeAsync(RELOAD_DEBOUNCE_MS);
    expect(harness.realtimeSignals.map((signal) => signal.channel)).toEqual([
      "whiteboard:settings",
    ]);
    expect(reloads()).toEqual([[{ pluginId: "whiteboard" }]]);
    expect(harness.logEntries).toEqual([
      { level: "warn", message: "whiteboard: a settings listener failed: Error: listener broke" },
    ]);
  });
});
