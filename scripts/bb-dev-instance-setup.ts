#!/usr/bin/env bun
/**
 * Put the pinned dev instance into a known baseline: the one bb that every
 * bb-plugins task targets, for captures and for live plugin testing alike.
 *
 * `prepareBbForScreenshots` already enforces plugin enablement and the theme on
 * every capture run, so this covers what preflight cannot: it installs the
 * workspace plugins (preflight only errors and prints the commands), returns
 * plugin settings to their declared defaults, and pins the experiment that
 * gates the onboarding overlay.
 *
 * Idempotent by design — running it twice is how you confirm it converged, and
 * it is the first thing to run after moving the worktree, because the instance
 * id derives from the worktree path and a moved worktree is a fresh instance.
 *
 * Resetting settings is the point, which makes it the wrong thing to run in the
 * middle of a test that deliberately set one. Run it to establish a baseline,
 * not to recover from a surprise.
 *
 * It rewrites settings, so it refuses to run against anything but a dev
 * instance. Pointed at the desktop app it would reset the developer's own
 * plugin configuration.
 */
import { join } from "node:path";
import {
  runBbCommand,
  SCREENSHOT_PREFLIGHT_PLUGINS,
  SCREENSHOT_ROOT,
  SCREENSHOT_THEME_ID,
  type BbCommandRunner,
} from "./plugin-screenshot-runtime";

/**
 * Written explicitly rather than left to bb's compiled-in defaults. bb persists
 * every experiment key once any of them is set, so an explicit value survives a
 * release that changes what the default is.
 *
 * `newOnboarding` is the one that matters: the first-run overlay renders when
 * it is on and `onboardingCompletedAt` is null, and the CLI can only clear that
 * timestamp, never stamp it. Holding the experiment off is what keeps the
 * overlay out of a capture.
 */
export const BB_DEV_EXPERIMENTS: Readonly<Record<string, boolean>> = {
  claudeCodeMockCliTraffic: false,
  editMessages: true,
  newOnboarding: false,
  providerSessionReaping: false,
};

interface PluginSchemaEntry {
  type?: string;
  secret?: boolean;
  default?: unknown;
}

interface PluginConfig {
  schema?: Record<string, PluginSchemaEntry>;
  values?: Record<string, unknown>;
}

/**
 * The keys holding something other than what the plugin declares as its
 * default. Unsetting these is what returns the instance to a documented state.
 *
 * Secrets are skipped: their value reads back as a `{ set: boolean }` envelope
 * rather than the stored string, so it can never equal a declared default and
 * would be reported as drift forever.
 */
export function driftingConfigKeys(config: PluginConfig): string[] {
  const schema = config.schema ?? {};
  const values = config.values ?? {};
  const keys = new Set([...Object.keys(schema), ...Object.keys(values)]);
  return [...keys]
    .filter((key) => {
      if (schema[key]?.secret === true) return false;
      if (!(key in values)) return false;
      return JSON.stringify(values[key]) !== JSON.stringify(schema[key]?.default);
    })
    .sort();
}

/**
 * The data directory tells the instances apart: every dev instance keeps one
 * under `~/.bb-dev`, production uses `~/.bb`. Checked against the reported
 * directory rather than against `BB_CLI`, because the shim is only a wrapper
 * and the URL it talks to is what decides which bb gets written to.
 */
export function assertDevInstance(config: { dataDir?: string }): void {
  const dataDir = config.dataDir ?? "";
  if (!/\/\.bb-dev\//.test(dataDir)) {
    throw new Error(
      [
        `refusing to configure a non-dev bb (data dir ${dataDir || "unknown"})`,
        "This rewrites settings and is only for the pinned screenshot instance.",
        "Point BB_CLI at scripts/bb-dev-cli and try again.",
      ].join("\n"),
    );
  }
}

function parseJson<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`could not read ${label} as JSON: ${raw.slice(0, 200)}`);
  }
}

interface InstalledPlugin {
  id?: string;
  rootDir?: string;
}

/** Installed plugin id to the directory bb recorded at install time. */
export function pluginSources(list: { plugins?: InstalledPlugin[] }): Map<string, string> {
  return new Map(
    (list.plugins ?? [])
      .filter(
        (plugin): plugin is { id: string; rootDir: string } =>
          typeof plugin.id === "string" && typeof plugin.rootDir === "string",
      )
      .map((plugin) => [plugin.id, plugin.rootDir]),
  );
}

/**
 * Installing restarts the plugin worker, and a capture started in that window
 * fails on a surface the plugin has not mounted yet — which reads as a broken
 * plugin rather than a race. Only reached when something was actually
 * installed; the steady-state run reinstalls nothing and waits for nothing.
 */
async function waitForRunningPlugins(
  runCommand: BbCommandRunner,
  attempts = 30,
  delayMs = 1000,
): Promise<void> {
  const listArgs = ["plugin", "list", "--json"] as const;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const list = parseJson<{ plugins?: { id?: string; status?: string }[] }>(
      await runCommand(listArgs),
      "bb plugin list",
    );
    const status = new Map((list.plugins ?? []).map((plugin) => [plugin.id, plugin.status]));
    const pending = SCREENSHOT_PREFLIGHT_PLUGINS.filter(
      (plugin) => status.get(plugin.id) !== "running",
    );
    if (pending.length === 0) return;
    if (attempt === attempts - 1) {
      throw new Error(`plugins did not start: ${pending.map((plugin) => plugin.id).join(", ")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

export async function setUpBbDevInstance(
  runCommand: BbCommandRunner = runBbCommand,
  log: (message: string) => void = console.log,
): Promise<void> {
  const settingsArgs = ["settings", "show", "--json"] as const;
  assertDevInstance(
    parseJson<{ dataDir?: string }>(await runCommand(settingsArgs), "bb settings show"),
  );

  const listArgs = ["plugin", "list", "--json"] as const;
  const installed = pluginSources(
    parseJson<{ plugins?: InstalledPlugin[] }>(await runCommand(listArgs), "bb plugin list"),
  );
  const stale = SCREENSHOT_PREFLIGHT_PLUGINS.filter(
    (plugin) => installed.get(plugin.id) !== join(SCREENSHOT_ROOT, "plugins", plugin.directory),
  );
  for (const plugin of stale) {
    // Absolute, because the CLI runs with the pinned worktree as its working
    // directory and a relative path would resolve against the wrong repo.
    const source = join(SCREENSHOT_ROOT, "plugins", plugin.directory);
    await runCommand(["plugin", "install", source, "--yes", "--json"]);
    log(`installed ${plugin.id}`);
  }
  if (stale.length === 0) log("all workspace plugins already installed from this checkout");
  else await waitForRunningPlugins(runCommand);

  for (const [key, value] of Object.entries(BB_DEV_EXPERIMENTS)) {
    await runCommand(["settings", "experiment", key, String(value), "--json"]);
  }
  log(`pinned ${Object.keys(BB_DEV_EXPERIMENTS).length} experiments`);

  for (const plugin of SCREENSHOT_PREFLIGHT_PLUGINS) {
    const configArgs = ["plugin", "config", plugin.id, "--json"] as const;
    const config = parseJson<PluginConfig>(
      await runCommand(configArgs),
      `bb plugin config ${plugin.id}`,
    );
    for (const key of driftingConfigKeys(config)) {
      await runCommand(["plugin", "config", plugin.id, "unset", key, "--json"]);
      log(`reset ${plugin.id}.${key} to its default`);
    }
  }

  await runCommand(["theme", "set", SCREENSHOT_THEME_ID, "--json"]);
  log(`theme set to ${SCREENSHOT_THEME_ID}`);

  // Independent read-back: the writes above each reported success, which is not
  // the same as the instance having converged.
  const remaining: string[] = [];
  for (const plugin of SCREENSHOT_PREFLIGHT_PLUGINS) {
    const configArgs = ["plugin", "config", plugin.id, "--json"] as const;
    const config = parseJson<PluginConfig>(
      await runCommand(configArgs),
      `bb plugin config ${plugin.id}`,
    );
    remaining.push(...driftingConfigKeys(config).map((key) => `${plugin.id}.${key}`));
  }
  if (remaining.length > 0) {
    throw new Error(`settings did not return to their defaults: ${remaining.join(", ")}`);
  }
  log("bb dev instance ready");
}

if (import.meta.main) {
  await setUpBbDevInstance();
}
