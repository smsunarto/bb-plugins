#!/usr/bin/env bun
import { join } from "node:path";
import { DevError } from "../packages/bb-kit-core/src/bin/dev/error.ts";
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
 * Keep the full release registry here. bb persists every key after one write,
 * so an explicit baseline survives a release that changes a default.
 */
export const BB_DEV_EXPERIMENTS: Readonly<Record<string, boolean>> = {
  changelogPreview: false,
  editMessages: true,
  mobileApp: false,
  timelineWindowing: false,
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
export function assertDevInstance(config: { dataDir?: string }, expectedDataDir?: string): void {
  const dataDir = config.dataDir ?? "";
  if (!/\/\.bb-dev\//.test(dataDir)) {
    throw new Error(
      [
        `refusing to configure a non-dev bb (data dir ${dataDir || "unknown"})`,
        "This rewrites settings and is only for the pinned screenshot instance.",
        "Run the baseline through bb-kit dev-instance run and try again.",
      ].join("\n"),
    );
  }
  if (expectedDataDir !== undefined && dataDir !== expectedDataDir) {
    throw new Error(
      [
        `refusing to configure the wrong dev bb (data dir ${dataDir})`,
        `Expected the managed data dir ${expectedDataDir}.`,
        "Run the baseline through the matching bb-kit dev-instance.",
      ].join("\n"),
    );
  }
}

export function routedSource(environment: NodeJS.ProcessEnv = process.env): "owned" | "attached" {
  const source = environment.BB_KIT_DEV_SOURCE;
  if (source === "owned" || source === "attached") {
    return source;
  }
  throw new DevError(
    "baseline_source_missing",
    "BB_KIT_DEV_SOURCE is not set to owned or attached. Run bun run dev:setup through the managed instance.",
    "Run bun run dev:setup through the managed dev-instance environment.",
  );
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

export async function prepareOwnedPluginFixture(
  runCommand: BbCommandRunner = runBbCommand,
  source: "owned" | "attached" = routedSource(),
  log: (message: string) => void = console.log,
  expectedDataDir?: string,
): Promise<void> {
  if (source === "attached") {
    throw new DevError(
      "baseline_refused",
      "The bb-plugins baseline cannot reset an attached bb instance.",
      "Start an owned release fixture with bun run dev:instance.",
    );
  }
  const settingsArgs = ["settings", "show", "--json"] as const;
  assertDevInstance(
    parseJson<{ dataDir?: string }>(await runCommand(settingsArgs), "bb settings show"),
    expectedDataDir,
  );

  await installWorkspacePlugins(runCommand, log);
  await resetPluginFixtureBaseline(runCommand, log);
  log("bb dev instance ready");
}

async function installWorkspacePlugins(
  runCommand: BbCommandRunner,
  log: (message: string) => void,
): Promise<void> {
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
}

async function resetPluginFixtureBaseline(
  runCommand: BbCommandRunner,
  log: (message: string) => void,
): Promise<void> {
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
}

if (import.meta.main) {
  const expectedFlag = process.argv.indexOf("--expected-data-dir");
  const expectedDataDir = expectedFlag < 0 ? undefined : process.argv[expectedFlag + 1];
  if (expectedFlag >= 0 && expectedDataDir === undefined) {
    throw new DevError(
      "invalid_arguments",
      "--expected-data-dir requires a value.",
      "Run the setup through bun run dev:instance.",
    );
  }
  await prepareOwnedPluginFixture(runBbCommand, routedSource(), console.log, expectedDataDir);
}
