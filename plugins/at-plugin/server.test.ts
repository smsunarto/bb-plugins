import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstalledPluginRecord } from "./installed-catalog";
import plugin, { SDK_READ_TIMEOUT_MS } from "./server";

function installed(overrides: Partial<InstalledPluginRecord> = {}): InstalledPluginRecord {
  return {
    app: { bundle: null, hasApp: false },
    capabilities: [],
    cliCommand: null,
    collections: [],
    description: "Plugin description",
    enabled: true,
    handlerStats: { count: 0, errorCount: 0, maxMs: 0, totalMs: 0 },
    hasSettings: false,
    icon: null,
    iconUrl: null,
    icons: {},
    id: "github",
    isOrphanedBuiltin: false,
    logoDarkUrl: null,
    logoUrl: null,
    name: "GitHub",
    provenance: "direct",
    providerIds: [],
    publisherLabel: null,
    rootDir: "/plugins/github",
    schedules: [],
    screenshots: [],
    services: [],
    source: "path:/plugins/github",
    sourceDisplay: "/plugins/github",
    status: "running",
    statusDetail: null,
    updateState: {},
    version: "1.0.0",
    ...overrides,
  };
}

const context = { trigger: "#", query: "", projectId: null, threadId: null } as const;
afterEach(() => vi.useRealTimers());
async function setup(plugins = [installed()]) {
  const { bb, harness } = createFakePluginHost({
    pluginId: "at-plugin",
    sdk: {
      plugins: { list: async () => ({ plugins }) },
    },
  });
  plugin(bb);
  const provider = harness.inspection.registrations.mentionProviders[0];
  if (!provider) throw new Error("Missing provider");
  return { provider, harness, plugins };
}
describe("installed mentions", () => {
  it("registers only # installed mentions and no CLI or agent tools", async () => {
    const { harness } = await setup();
    expect(
      harness.inspection.registrations.mentionProviders.map(({ id, triggers }) => ({
        id,
        triggers,
      })),
    ).toEqual([{ id: "installed", triggers: ["#"] }]);
    expect(harness.inspection.registrations.cli).toBeNull();
    expect(harness.inspection.registrations.agentTools).toEqual([]);
  });
  it("browses all usable plugins and never queries Community even on a miss", async () => {
    const { provider, harness } = await setup(
      Array.from({ length: 9 }, (_, i) => installed({ id: `tool-${i}`, name: `Tool ${i}` })),
    );
    expect(await provider.search({ ...context, query: "plugins" })).toHaveLength(9);
    expect(await provider.search({ ...context, query: "tool" })).toHaveLength(6);
    expect(await provider.search({ ...context, query: "missing" })).toEqual([]);
    expect(harness.inspection.sdk.calls.every((call) => call.path === "plugins.list")).toBe(true);
  });
  it("resolves using current metadata and blocks removed or disabled targets", async () => {
    const { provider, plugins } = await setup();
    const [item] = await provider.search(context);
    if (!item) throw new Error("Missing item");
    plugins[0]!.name = "Renamed GitHub";
    expect((await provider.resolve(item.id)).context).toContain('Name: "Renamed GitHub"');
    plugins[0]!.enabled = false;
    await expect(provider.resolve(item.id)).rejects.toThrow("not currently usable");
    plugins.pop();
    await expect(provider.resolve(item.id)).rejects.toThrow("no longer installed");
  });
  it("rejects malformed IDs without reading inventory", async () => {
    const { provider, harness } = await setup();
    await expect(provider.resolve("bad:identity")).rejects.toThrow("invalid");
    expect(harness.inspection.sdk.calls).toEqual([]);
  });
  it("isolates failed reads and gives a useful send error", async () => {
    const { provider, harness } = await setup();
    harness.inspection.sdk.stub("plugins.list", () => {
      throw new Error("private diagnostic");
    });
    expect(await provider.search(context)).toEqual([]);
    await expect(provider.resolve("github")).rejects.toThrow("could not be verified");
  });
  it("bounds a stalled read and aborts its SDK request", async () => {
    vi.useFakeTimers();
    const { provider, harness } = await setup();
    let signal: AbortSignal | undefined;
    harness.inspection.sdk.stub("plugins.list", (args) => {
      signal = (args as { signal: AbortSignal }).signal;
      return new Promise(() => {});
    });
    const pending = provider.search(context);
    await vi.advanceTimersByTimeAsync(SDK_READ_TIMEOUT_MS);
    expect(await pending).toEqual([]);
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
