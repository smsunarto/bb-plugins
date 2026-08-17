import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  assertDevInstance,
  driftingConfigKeys,
  BB_DEV_EXPERIMENTS,
  setUpBbDevInstance,
} from "./bb-dev-instance-setup";
import {
  SCREENSHOT_PREFLIGHT_PLUGINS,
  SCREENSHOT_ROOT,
  SCREENSHOT_THEME_ID,
} from "./plugin-screenshot-runtime";

const DEV_SETTINGS = JSON.stringify({
  dataDir: "/Users/example/.bb-dev/bb-worktrees-dev-bb-5468d9357fa9",
});

/** A runner that answers every read with defaults and records every write. */
function fakeBb(
  options: { drift?: Record<string, Record<string, unknown>>; missing?: string[] } = {},
) {
  const calls: string[][] = [];
  const drift = options.drift ?? {};
  const run = async (args: readonly string[]): Promise<string> => {
    calls.push([...args]);
    if (args[0] === "settings" && args[1] === "show") return DEV_SETTINGS;
    if (args[0] === "plugin" && args[1] === "list") {
      return JSON.stringify({
        plugins: SCREENSHOT_PREFLIGHT_PLUGINS.map((plugin) => ({
          id: plugin.id,
          status: "running",
          rootDir: options.missing?.includes(plugin.id)
            ? "/tmp/elsewhere"
            : join(SCREENSHOT_ROOT, "plugins", plugin.directory),
        })),
      });
    }
    if (args[0] === "plugin" && args[1] === "config" && args.length === 4) {
      const id = args[2]!;
      // A key is only reported as drifting until it has been unset.
      const unset = new Set(
        calls
          .filter((call) => call[1] === "config" && call[2] === id && call[3] === "unset")
          .map((call) => call[4]!),
      );
      const values = Object.fromEntries(
        Object.entries(drift[id] ?? {}).filter(([key]) => !unset.has(key)),
      );
      return JSON.stringify({
        schema: { tidy: { type: "boolean", default: true } },
        values: { tidy: true, ...values },
      });
    }
    return JSON.stringify({ ok: true });
  };
  return { calls, run };
}

describe("driftingConfigKeys", () => {
  test("names only the keys holding something other than the default", () => {
    expect(
      driftingConfigKeys({
        schema: { a: { default: true }, b: { default: "8317" } },
        values: { a: false, b: "8317" },
      }),
    ).toEqual(["a"]);
  });

  test("ignores a key that was never set", () => {
    expect(driftingConfigKeys({ schema: { a: { default: true } }, values: {} })).toEqual([]);
  });

  test("ignores secrets, whose value is a set/unset envelope", () => {
    expect(
      driftingConfigKeys({
        schema: { key: { secret: true } },
        values: { key: { set: false } },
      }),
    ).toEqual([]);
  });

  test("reports a stored key the schema no longer declares", () => {
    expect(driftingConfigKeys({ schema: {}, values: { gone: 1 } })).toEqual(["gone"]);
  });
});

describe("assertDevInstance", () => {
  test("accepts a dev data dir", () => {
    expect(() => assertDevInstance({ dataDir: "/Users/e/.bb-dev/inst" })).not.toThrow();
  });

  test("refuses production", () => {
    expect(() => assertDevInstance({ dataDir: "/Users/e/.bb" })).toThrow(/refusing/);
  });

  test("refuses an unknown data dir", () => {
    expect(() => assertDevInstance({})).toThrow(/unknown/);
  });
});

describe("setUpBbDevInstance", () => {
  test("refuses before writing anything when the target is not a dev instance", async () => {
    const calls: string[][] = [];
    await expect(
      setUpBbDevInstance(async (args) => {
        calls.push([...args]);
        return JSON.stringify({ dataDir: "/Users/e/.bb" });
      }, () => {}),
    ).rejects.toThrow(/refusing/);
    expect(calls).toEqual([["settings", "show", "--json"]]);
  });

  test("reinstalls nothing when every plugin already comes from this checkout", async () => {
    const bb = fakeBb();
    await setUpBbDevInstance(bb.run, () => {});
    expect(bb.calls.filter((call) => call[1] === "install")).toEqual([]);
  });

  test("installs only the plugins sourced from somewhere else, by absolute path", async () => {
    const id = SCREENSHOT_PREFLIGHT_PLUGINS[1]!;
    const bb = fakeBb({ missing: [id.id] });
    await setUpBbDevInstance(bb.run, () => {});
    const installs = bb.calls.filter((call) => call[1] === "install").map((call) => call[2]);
    expect(installs).toEqual([join(SCREENSHOT_ROOT, "plugins", id.directory)]);
  });

  test("pins every experiment and sets the theme", async () => {
    const bb = fakeBb();
    await setUpBbDevInstance(bb.run, () => {});
    const experiments = bb.calls
      .filter((call) => call[1] === "experiment")
      .map((call) => [call[2], call[3]]);
    expect(experiments).toEqual(
      Object.entries(BB_DEV_EXPERIMENTS).map(([key, value]) => [key, String(value)]),
    );
    expect(bb.calls).toContainEqual(["theme", "set", SCREENSHOT_THEME_ID, "--json"]);
  });

  test("unsets a drifting key and leaves a defaulted one alone", async () => {
    const id = SCREENSHOT_PREFLIGHT_PLUGINS[0]!.id;
    const bb = fakeBb({ drift: { [id]: { tidy: false } } });
    await setUpBbDevInstance(bb.run, () => {});
    const unsets = bb.calls.filter((call) => call[3] === "unset");
    expect(unsets).toEqual([["plugin", "config", id, "unset", "tidy", "--json"]]);
  });

  test("fails when a key does not return to its default", async () => {
    const id = SCREENSHOT_PREFLIGHT_PLUGINS[0]!.id;
    await expect(
      setUpBbDevInstance(async (args) => {
        if (args[0] === "settings" && args[1] === "show") return DEV_SETTINGS;
        if (args[0] === "plugin" && args[1] === "list") {
          return JSON.stringify({
            plugins: SCREENSHOT_PREFLIGHT_PLUGINS.map((plugin) => ({
              id: plugin.id,
              status: "running",
              rootDir: join(SCREENSHOT_ROOT, "plugins", plugin.directory),
            })),
          });
        }
        if (args[0] === "plugin" && args[1] === "config" && args.length === 4) {
          return JSON.stringify({
            schema: { tidy: { type: "boolean", default: true } },
            values: { tidy: args[2] === id ? false : true },
          });
        }
        return JSON.stringify({ ok: true });
      }, () => {}),
    ).rejects.toThrow(new RegExp(`did not return to their defaults: ${id}\\.tidy`));
  });
});
