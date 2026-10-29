import { describe, expect, it } from "vitest";

import {
  type InstalledPluginRecord,
  isUsableInstalledTarget,
  searchInstalledPlugins,
} from "./installed-catalog";
import { decodeInstalledItemId, utf8ByteLength } from "./mention-context";

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
    id: "example",
    isOrphanedBuiltin: false,
    logoDarkUrl: null,
    logoUrl: null,
    name: "Example",
    provenance: "direct",
    providerIds: [],
    publisherLabel: null,
    rootDir: "/plugins/example",
    schedules: [],
    screenshots: [],
    services: [],
    source: "path:/plugins/example",
    sourceDisplay: "/plugins/example",
    status: "running",
    statusDetail: null,
    updateState: {},
    version: "1.0.0",
    ...overrides,
  };
}

function capability(
  kind: InstalledPluginRecord["capabilities"][number]["kind"],
): InstalledPluginRecord["capabilities"][number] {
  return { detail: null, id: `${kind}-id`, kind, label: kind };
}

describe("Installed eligibility", () => {
  it("accepts running CLI, skill, and agent-tool plugins", () => {
    const cli = installed({ cliCommand: { name: "example", summary: "Run it" } });
    const skill = installed({ capabilities: [capability("skill")] });
    const tool = installed({ capabilities: [capability("agent-tool")] });

    expect([cli, skill, tool].every((plugin) => isUsableInstalledTarget(plugin))).toBe(true);
  });

  it("rejects every non-running status", () => {
    const statuses: InstalledPluginRecord["status"][] = [
      "needs-configuration",
      "degraded",
      "disabled",
      "error",
      "incompatible",
      "missing",
    ];
    const plugins = statuses.map((status) =>
      installed({ id: status, name: status, status, capabilities: [capability("skill")] }),
    );

    expect(searchInstalledPlugins(plugins, "")).toEqual([]);
  });

  it("includes every enabled running plugin, including UI, themes, and itself", () => {
    const plugins = [
      installed({ id: "at-plugin", capabilities: [capability("skill")] }),
      installed({ id: "ui-only", app: { bundle: null, hasApp: true } }),
      installed({ id: "theme-only", capabilities: [capability("theme")] }),
      installed({ id: "mention-only", capabilities: [capability("thread-integration")] }),
      installed({ id: "nothing" }),
      installed({ id: "disabled-flag", enabled: false }),
    ];

    expect(
      searchInstalledPlugins(plugins, "plugin").map(
        (item) => decodeInstalledItemId(item.id).pluginId,
      ),
    ).toEqual(["at-plugin", "mention-only", "nothing", "theme-only", "ui-only"]);
  });
});

describe("Installed discovery", () => {
  it("matches name, id, and description case-insensitively after normalization", () => {
    const plugins = [
      installed({ id: "alpha-id", name: " Alpha\tPlugin ", capabilities: [capability("skill")] }),
      installed({
        id: "beta-id",
        name: "Beta",
        description: "Works with\nFROBNICATORS",
        capabilities: [capability("agent-tool")],
      }),
    ];

    expect(searchInstalledPlugins(plugins, "alpha plugin").map((item) => item.title)).toEqual([
      "Alpha Plugin",
    ]);
    expect(searchInstalledPlugins(plugins, "BETA-ID").map((item) => item.title)).toEqual(["Beta"]);
    expect(searchInstalledPlugins(plugins, "frob").map((item) => item.title)).toEqual(["Beta"]);
  });

  it("ranks exact name/id, then prefix, then substring with deterministic ties", () => {
    const plugins = [
      installed({ id: "z-substring", name: "The Git Helper", capabilities: [capability("skill")] }),
      installed({ id: "git", name: "Zulu", capabilities: [capability("skill")] }),
      installed({ id: "prefix", name: "Git Alpha", capabilities: [capability("skill")] }),
      installed({ id: "exact-name", name: "Git", capabilities: [capability("skill")] }),
      installed({ id: "prefix-two", name: "Git Beta", capabilities: [capability("skill")] }),
    ];

    expect(searchInstalledPlugins(plugins, "git").map((item) => item.title)).toEqual([
      "Git",
      "Zulu",
      "Git Alpha",
      "Git Beta",
      "The Git Helper",
    ]);
  });

  it("disambiguates duplicate normalized names with stable ids", () => {
    const plugins = [
      installed({
        id: "github-one",
        name: "Git   Hub",
        description: "First",
        capabilities: [capability("skill")],
      }),
      installed({
        id: "github-two",
        name: "git hub",
        description: "Second",
        capabilities: [capability("skill")],
      }),
    ];

    const items = searchInstalledPlugins(plugins, "");
    expect(items).toHaveLength(2);
    expect(items[0]?.subtitle).toMatch(/^github-one · First$/);
    expect(items[1]?.subtitle).toMatch(/^github-two · Second$/);
  });

  it("sanitizes and bounds host-visible fields and preserves stable identity", () => {
    const plugin = installed({
      id: "safe:id%一",
      name: `\u0000  Name\n${"😀".repeat(100)}`,
      description: `\u0085Description\t${"界".repeat(200)}`,
      capabilities: [capability("skill")],
    });
    const [item] = searchInstalledPlugins([plugin], "");

    // Assert controls cannot leak into composer rows.
    // eslint-disable-next-line no-control-regex
    expect(item?.title).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
    // eslint-disable-next-line no-control-regex
    expect(item?.subtitle).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
    expect(utf8ByteLength(item?.title ?? "")).toBeLessThanOrEqual(120);
    expect(utf8ByteLength(item?.subtitle ?? "")).toBeLessThanOrEqual(240);
    expect(decodeInstalledItemId(item?.id ?? "")).toEqual({ pluginId: "safe:id%一" });
  });

  it("uses each plugin's own branding icon, else the Plugins icon", () => {
    const plugins = [
      installed({ id: "named", name: "Named", icon: "Palette" }),
      installed({
        id: "asset",
        name: "Asset",
        icon: "./assets/map.svg",
        iconUrl: "/api/v1/plugins/asset/assets/icon?h=abc",
        icons: {
          other: "/api/v1/plugins/asset/assets/icons/other.svg?h=def",
          map: "/api/v1/plugins/asset/assets/icons/map.svg?h=abc",
        },
      }),
      installed({
        id: "file",
        name: "File",
        icon: "./assets/icon.svg",
        iconUrl: "/api/v1/plugins/file/assets/icon?h=abc",
        icons: { ball: "/api/v1/plugins/file/assets/icons/ball.svg?h=def" },
      }),
      installed({ id: "none", name: "None" }),
    ];

    expect(
      searchInstalledPlugins(plugins, "plugin").map((item) => [item.title, item.icon]),
    ).toEqual([
      ["Asset", "asset/map"],
      ["File", "Plug02"],
      ["Named", "Palette"],
      ["None", "Plug02"],
    ]);
  });

  it("falls back to the Plugins icon on hosts that omit the icons map", () => {
    const legacy = installed({
      id: "legacy",
      name: "Legacy",
      icon: "./assets/icon.svg",
      iconUrl: "/api/v1/plugins/legacy/assets/icon?h=abc",
    });
    delete (legacy as Partial<InstalledPluginRecord>).icons;
    const unsafeKey = installed({
      id: "unsafe",
      name: "Unsafe",
      icon: "./assets/icon.svg",
      iconUrl: "/api/v1/plugins/unsafe/assets/icon?h=abc",
      icons: { "Not A Name": "/api/v1/plugins/unsafe/assets/icons/x.svg?h=abc" },
    });

    expect(
      searchInstalledPlugins([legacy, unsafeKey], "plugin").map((item) => [item.title, item.icon]),
    ).toEqual([
      ["Legacy", "Plug02"],
      ["Unsafe", "Plug02"],
    ]);
  });

  it("returns at most six rows", () => {
    const plugins = Array.from({ length: 9 }, (_, index) =>
      installed({
        id: `plugin-${index}`,
        name: `Plugin ${index}`,
        capabilities: [capability("skill")],
      }),
    );

    expect(searchInstalledPlugins(plugins, "")).toHaveLength(6);
  });
});
