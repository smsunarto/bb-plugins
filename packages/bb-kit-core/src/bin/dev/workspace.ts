import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { derivePluginID } from "../derive-plugin-id.ts";
import { DevError } from "./error.ts";
import type {
  CapturedCommand,
  DevManager,
  InstanceResult,
  StartOptions,
} from "./manager.ts";

const DEFAULT_PLUGIN_READY_TIMEOUT_MS = 30_000;
const PLUGIN_READY_POLL_MS = 500;

export type DevWorkspaceProfile = {
  schemaVersion: 1;
  pluginDirectory: string;
  packageManager: "bun";
  beforeBuild: readonly string[];
  watchExclude: readonly string[];
  experiments: Readonly<Record<string, boolean>>;
  theme: string;
};

export type WorkspacePlugin = {
  id: string;
  packageName: string;
  directory: string;
  root: string;
  scripts: Readonly<Record<string, string>>;
};

export type WorkspaceDefinition = {
  root: string;
  profile: DevWorkspaceProfile;
  plugins: readonly WorkspacePlugin[];
};

export type WorkspaceResult = {
  instance: InstanceResult;
  workspace: string;
  plugins: {
    discovered: readonly string[];
    built: readonly string[];
    installed: readonly string[];
    unchanged: readonly string[];
    enabled: readonly string[];
    watched: readonly string[];
  };
  baseline: {
    experimentsSet: readonly string[];
    configKeysReset: readonly { pluginId: string; key: string }[];
    themeChanged: boolean;
    converged: true;
  };
};

export type WorkspaceOptions = StartOptions & {
  watch: boolean;
};

type RunOptions = {
  stdout?: "inherit" | "stderr";
  cwd?: string;
};

export interface WorkspaceRuntime {
  readonly cwd: string;
  start(options?: StartOptions): Promise<InstanceResult>;
  run(
    name: string | undefined,
    argv: readonly [string, ...string[]],
    options?: RunOptions,
  ): Promise<number>;
  captureExec(
    name: string | undefined,
    args: readonly string[],
    timeoutMs?: number,
  ): Promise<CapturedCommand>;
}

type WorkspaceDependencies = {
  sleep?: (delayMs: number) => Promise<void>;
  now?: () => number;
  pluginReadyTimeoutMs?: number;
  progress?: (message: string) => void;
};

type PluginListEntry = {
  id?: string;
  rootDir?: string;
  enabled?: boolean;
  status?: string;
};

type PluginConfig = {
  schema?: Record<string, { secret?: boolean; default?: unknown }>;
  values?: Record<string, unknown>;
};

export function loadWorkspaceDefinition(root: string): WorkspaceDefinition {
  const workspace = resolve(root);
  const manifestPath = join(workspace, "package.json");
  const manifest = readJsonObject(manifestPath, "workspace package.json");
  const bbKit = objectField(manifest, "bbKit", "workspace package.json");
  const rawProfile = objectField(bbKit, "devInstance", "bbKit");
  const profile = parseProfile(rawProfile, manifest);
  const pluginsRoot = resolveWithin(workspace, profile.pluginDirectory, "pluginDirectory");
  if (!existsSync(pluginsRoot)) {
    invalidProfile(`Plugin directory ${pluginsRoot} does not exist.`);
  }

  const plugins = readdirSync(pluginsRoot)
    .sort()
    .flatMap((directory): WorkspacePlugin[] => {
      const pluginRoot = join(pluginsRoot, directory);
      const pluginManifestPath = join(pluginRoot, "package.json");
      if (!existsSync(pluginManifestPath)) return [];
      const pluginManifest = readJsonObject(pluginManifestPath, `${directory}/package.json`);
      const packageName = pluginManifest["name"];
      if (typeof packageName !== "string" || !unscoped(packageName).startsWith("bb-plugin-")) {
        return [];
      }
      const scripts = optionalObjectField(pluginManifest, "scripts", `${directory}/package.json`);
      if (typeof scripts["build"] !== "string") {
        invalidProfile(`${packageName} has no build script.`);
      }
      return [
        {
          id: derivePluginID(packageName),
          packageName,
          directory,
          root: pluginRoot,
          scripts: stringRecord(scripts, `${directory}/package.json scripts`),
        },
      ];
    });

  const ids = new Set(plugins.map((plugin) => plugin.id));
  const unknownExclusions = profile.watchExclude.filter((id) => !ids.has(id));
  if (unknownExclusions.length > 0) {
    invalidProfile(`watchExclude names unknown plugins: ${unknownExclusions.join(", ")}.`);
  }
  return { root: workspace, profile, plugins };
}

export async function runWorkspace(
  runtime: DevManager | WorkspaceRuntime,
  options: WorkspaceOptions,
  dependencies: WorkspaceDependencies = {},
): Promise<WorkspaceResult> {
  if (options.attach !== undefined) {
    throw new DevError(
      "attached_source_unsupported",
      "A plugin workspace cannot reset an attached bb instance.",
      "Use bb-kit dev-instance start --attach for bb core development.",
    );
  }
  const definition = loadWorkspaceDefinition(runtime.cwd);
  const progress = dependencies.progress ?? (() => {});
  const instance = await runtime.start({
    name: options.name,
    revision: options.revision,
    repository: options.repository,
    desktop: options.desktop,
    open: options.open,
    timeoutMs: options.timeoutMs,
  });
  assertOwnedTarget(instance);

  const built: string[] = [];
  for (const script of definition.profile.beforeBuild) {
    await runPackageScript(runtime, instance.name, definition.root, script, "build_failed");
  }
  for (const plugin of definition.plugins) {
    await runPackageScript(runtime, instance.name, plugin.root, "build", "plugin_build_failed");
    built.push(plugin.id);
  }

  const initial = pluginMap(
    await bbJson<{ plugins?: PluginListEntry[] }>(runtime, instance.name, [
      "plugin",
      "list",
      "--json",
    ]),
  );
  const installed: string[] = [];
  const unchanged: string[] = [];
  for (const plugin of definition.plugins) {
    if (samePath(initial.get(plugin.id)?.rootDir, plugin.root)) {
      unchanged.push(plugin.id);
      continue;
    }
    await bbJson(runtime, instance.name, ["plugin", "install", plugin.root, "--yes", "--json"]);
    installed.push(plugin.id);
    progress(`Installed ${plugin.id}`);
  }

  const afterInstall = pluginMap(
    await bbJson<{ plugins?: PluginListEntry[] }>(runtime, instance.name, [
      "plugin",
      "list",
      "--json",
    ]),
  );
  const enabled: string[] = [];
  for (const plugin of definition.plugins) {
    if (afterInstall.get(plugin.id)?.enabled !== false) continue;
    await bbJson(runtime, instance.name, ["plugin", "enable", plugin.id, "--json"]);
    enabled.push(plugin.id);
  }

  await waitForPlugins(runtime, instance.name, definition.plugins, dependencies);

  const settings = await bbJson<{ dataDir?: string; experiments?: Record<string, boolean> }>(
    runtime,
    instance.name,
    ["settings", "show", "--json"],
  );
  assertDataDirectory(settings.dataDir, instance.dataDir);
  const experimentsSet: string[] = [];
  for (const [key, value] of Object.entries(definition.profile.experiments)) {
    if (settings.experiments?.[key] === value) continue;
    await bbJson(runtime, instance.name, ["settings", "experiment", key, String(value), "--json"]);
    experimentsSet.push(key);
  }

  const configKeysReset: { pluginId: string; key: string }[] = [];
  for (const plugin of definition.plugins) {
    const config = await bbJson<PluginConfig>(runtime, instance.name, [
      "plugin",
      "config",
      plugin.id,
      "--json",
    ]);
    for (const key of driftingConfigKeys(config)) {
      await bbJson(runtime, instance.name, ["plugin", "config", plugin.id, "unset", key, "--json"]);
      configKeysReset.push({ pluginId: plugin.id, key });
    }
  }

  const theme = await bbJson<{ themeId?: string }>(runtime, instance.name, [
    "theme",
    "show",
    "--json",
  ]);
  const themeChanged = theme.themeId !== definition.profile.theme;
  if (themeChanged) {
    await bbJson(runtime, instance.name, ["theme", "set", definition.profile.theme, "--json"]);
  }

  await assertConverged(runtime, instance, definition);
  progress(`Workspace ready at ${instance.appUrl ?? "an unknown app URL"}`);

  const watched = definition.plugins
    .filter((plugin) => !definition.profile.watchExclude.includes(plugin.id))
    .filter((plugin) => typeof plugin.scripts["dev"] === "string");
  if (options.watch && watched.length > 0) {
    const watchCommand: [string, ...string[]] = [definition.profile.packageManager, "run"];
    for (const plugin of watched) watchCommand.push("--filter", plugin.packageName);
    watchCommand.push("--parallel", "--no-orphans", "dev");
    const exitCode = await runtime.run(instance.name, watchCommand, { cwd: definition.root });
    if (exitCode !== 0) {
      throw new DevError(
        "watch_failed",
        `Plugin watchers exited with status ${exitCode}.`,
        "Fix the watcher error, then rerun the workspace command.",
      );
    }
  }

  return {
    instance,
    workspace: definition.root,
    plugins: {
      discovered: definition.plugins.map((plugin) => plugin.id),
      built,
      installed,
      unchanged,
      enabled,
      watched: options.watch ? watched.map((plugin) => plugin.id) : [],
    },
    baseline: { experimentsSet, configKeysReset, themeChanged, converged: true },
  };
}

export function driftingConfigKeys(config: PluginConfig): string[] {
  const schema = config.schema ?? {};
  const values = config.values ?? {};
  return [...new Set([...Object.keys(schema), ...Object.keys(values)])]
    .filter((key) => {
      if (schema[key]?.secret === true || !(key in values)) return false;
      return JSON.stringify(values[key]) !== JSON.stringify(schema[key]?.default);
    })
    .sort();
}

async function runPackageScript(
  runtime: WorkspaceRuntime,
  name: string,
  cwd: string,
  script: string,
  code: string,
): Promise<void> {
  const exitCode = await runtime.run(name, ["bun", "run", script], { cwd, stdout: "stderr" });
  if (exitCode === 0) return;
  throw new DevError(
    code,
    `${script} in ${cwd} exited with status ${exitCode}.`,
    "Fix the build error, then rerun the workspace command.",
  );
}

async function waitForPlugins(
  runtime: WorkspaceRuntime,
  name: string,
  plugins: readonly WorkspacePlugin[],
  dependencies: WorkspaceDependencies,
): Promise<void> {
  const sleep =
    dependencies.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const now = dependencies.now ?? Date.now;
  const deadline = now() + (dependencies.pluginReadyTimeoutMs ?? DEFAULT_PLUGIN_READY_TIMEOUT_MS);
  while (true) {
    const states = pluginMap(
      await bbJson<{ plugins?: PluginListEntry[] }>(runtime, name, ["plugin", "list", "--json"]),
    );
    const pending = plugins.filter((plugin) => {
      const state = states.get(plugin.id);
      return (
        !samePath(state?.rootDir, plugin.root) ||
        state?.enabled !== true ||
        state.status !== "running"
      );
    });
    if (pending.length === 0) return;
    if (now() >= deadline) {
      throw new DevError(
        "plugin_ready_timeout",
        `Plugins did not become ready: ${pending.map((plugin) => plugin.id).join(", ")}.`,
        "Inspect bb-kit dev-instance logs, then rerun the workspace command.",
      );
    }
    await sleep(PLUGIN_READY_POLL_MS);
  }
}

async function assertConverged(
  runtime: WorkspaceRuntime,
  instance: InstanceResult,
  definition: WorkspaceDefinition,
): Promise<void> {
  const failures: string[] = [];
  const settings = await bbJson<{ dataDir?: string; experiments?: Record<string, boolean> }>(
    runtime,
    instance.name,
    ["settings", "show", "--json"],
  );
  try {
    assertDataDirectory(settings.dataDir, instance.dataDir);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  for (const [key, value] of Object.entries(definition.profile.experiments)) {
    if (settings.experiments?.[key] !== value) failures.push(`experiment ${key} is not ${value}`);
  }

  const states = pluginMap(
    await bbJson<{ plugins?: PluginListEntry[] }>(runtime, instance.name, [
      "plugin",
      "list",
      "--json",
    ]),
  );
  for (const plugin of definition.plugins) {
    const state = states.get(plugin.id);
    if (!samePath(state?.rootDir, plugin.root)) failures.push(`${plugin.id} has the wrong source`);
    if (state?.enabled !== true) failures.push(`${plugin.id} is disabled`);
    if (state?.status !== "running") failures.push(`${plugin.id} is not running`);
    const config = await bbJson<PluginConfig>(runtime, instance.name, [
      "plugin",
      "config",
      plugin.id,
      "--json",
    ]);
    for (const key of driftingConfigKeys(config)) failures.push(`${plugin.id}.${key} still drifts`);
  }
  const theme = await bbJson<{ themeId?: string }>(runtime, instance.name, [
    "theme",
    "show",
    "--json",
  ]);
  if (theme.themeId !== definition.profile.theme) {
    failures.push(`theme is ${theme.themeId ?? "unknown"}, expected ${definition.profile.theme}`);
  }
  if (failures.length === 0) return;
  throw new DevError(
    "workspace_not_converged",
    `The workspace baseline did not converge: ${failures.join("; ")}.`,
    "Inspect the reported state, then rerun the workspace command.",
    { failures },
  );
}

async function bbJson<T = unknown>(
  runtime: WorkspaceRuntime,
  name: string,
  args: readonly string[],
): Promise<T> {
  const result = await runtime.captureExec(name, args);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit status ${result.exitCode}`;
    throw new DevError(
      "workspace_bb_command_failed",
      `bb ${args.join(" ")} failed: ${detail}`,
      "Fix the bb command error, then rerun the workspace command.",
    );
  }
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new DevError(
      "workspace_bb_json_invalid",
      `bb ${args.join(" ")} returned invalid JSON.`,
      "Inspect the managed bb version and command output.",
      { output: result.stdout.slice(0, 200) },
    );
  }
}

function parseProfile(
  value: Record<string, unknown>,
  rootManifest: Record<string, unknown>,
): DevWorkspaceProfile {
  if (value["schemaVersion"] !== 1) invalidProfile("schemaVersion must be 1.");
  const packageManager = value["packageManager"];
  if (packageManager !== "bun") invalidProfile('packageManager must be "bun".');
  const pluginDirectory = nonEmptyString(value["pluginDirectory"], "pluginDirectory");
  const beforeBuild = stringArray(value["beforeBuild"], "beforeBuild");
  const rootScripts = optionalObjectField(rootManifest, "scripts", "workspace package.json");
  for (const script of beforeBuild) {
    if (typeof rootScripts[script] !== "string")
      invalidProfile(`beforeBuild script ${script} does not exist.`);
  }
  const watchExclude = stringArray(value["watchExclude"], "watchExclude");
  const rawExperiments = objectField(value, "experiments", "bbKit.devInstance");
  const experiments: Record<string, boolean> = {};
  for (const [key, experiment] of Object.entries(rawExperiments)) {
    if (typeof experiment !== "boolean") invalidProfile(`experiment ${key} must be boolean.`);
    experiments[key] = experiment;
  }
  const theme = nonEmptyString(value["theme"], "theme");
  return {
    schemaVersion: 1,
    pluginDirectory,
    packageManager,
    beforeBuild,
    watchExclude,
    experiments,
    theme,
  };
}

function assertOwnedTarget(instance: InstanceResult): asserts instance is InstanceResult & {
  source: "owned";
  dataDir: string;
} {
  if (instance.source !== "owned") {
    throw new DevError(
      "baseline_refused",
      "A plugin workspace can configure only an owned bb instance.",
      "Use an owned revision selector with bb-kit dev-instance workspace.",
    );
  }
  if (instance.dataDir === null) {
    throw new DevError(
      "baseline_target_missing",
      "The managed instance did not report its data directory.",
      "Inspect bb-kit dev-instance status, then retry the workspace command.",
    );
  }
}

function assertDataDirectory(actual: string | undefined, expected: string | null): void {
  if (actual === undefined || expected === null || resolve(actual) !== resolve(expected)) {
    throw new DevError(
      "baseline_target_mismatch",
      `The routed bb data directory is ${actual ?? "unknown"}, expected ${expected ?? "unknown"}.`,
      "Check the selected dev instance, then rerun the workspace command.",
    );
  }
  if (!resolve(actual).split(sep).includes(".bb-dev")) {
    throw new DevError(
      "baseline_refused",
      `Refusing to configure a non-dev bb data directory at ${actual}.`,
      "Run the command through bb-kit dev-instance workspace.",
    );
  }
}

function pluginMap(value: { plugins?: PluginListEntry[] }): Map<string, PluginListEntry> {
  return new Map(
    (value.plugins ?? [])
      .filter((plugin): plugin is PluginListEntry & { id: string } => typeof plugin.id === "string")
      .map((plugin) => [plugin.id, plugin]),
  );
}

function samePath(left: string | undefined, right: string): boolean {
  return left !== undefined && resolve(left) === resolve(right);
}

function unscoped(packageName: string): string {
  return packageName.includes("/") ? (packageName.split("/").at(-1) ?? packageName) : packageName;
}

function readJsonObject(path: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    invalidProfile(`Could not read ${label} at ${path}: ${String(error)}.`);
  }
  if (!isObject(value)) invalidProfile(`${label} must contain a JSON object.`);
  return value;
}

function resolveWithin(root: string, value: string, label: string): string {
  if (isAbsolute(value)) invalidProfile(`${label} must be relative to the workspace.`);
  const path = resolve(root, value);
  const fromRoot = relative(root, path);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    invalidProfile(`${label} must stay inside the workspace.`);
  }
  return path;
}

function objectField(
  value: Record<string, unknown>,
  key: string,
  label: string,
): Record<string, unknown> {
  const field = value[key];
  if (!isObject(field)) invalidProfile(`${label}.${key} must be an object.`);
  return field;
}

function optionalObjectField(
  value: Record<string, unknown>,
  key: string,
  label: string,
): Record<string, unknown> {
  const field = value[key];
  if (field === undefined) return {};
  if (!isObject(field)) invalidProfile(`${label}.${key} must be an object.`);
  return field;
}

function stringRecord(value: Record<string, unknown>, label: string): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") invalidProfile(`${label}.${key} must be a string.`);
    output[key] = item;
  }
  return output;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) invalidProfile(`${label} must be an array of strings.`);
  return value.map((item, index) => nonEmptyString(item, `${label}[${index}]`));
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "")
    invalidProfile(`${label} must be a non-empty string.`);
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidProfile(message: string): never {
  throw new DevError(
    "invalid_workspace_profile",
    message,
    "Fix bbKit.devInstance in the workspace package.json.",
  );
}
