import { realpathSync } from "node:fs";
import { compatibility, isCompatibleHostVersion } from "./compatibility.js";
import { operationInvokeCommand } from "./invoke.js";
import {
  defaultCommandRunner,
  processFailure,
  ProcessError,
  selectBbCli,
  type CommandRunner,
  type SelectedBbCli,
} from "./process.js";
import { discoverProject } from "./project.js";

interface HostVersionOutput {
  readonly currentVersion?: unknown;
}

interface PluginListEntry {
  readonly id?: unknown;
  readonly source?: unknown;
  readonly rootDir?: unknown;
  readonly version?: unknown;
  readonly enabled?: unknown;
  readonly status?: unknown;
  readonly statusDetail?: unknown;
  readonly app?: unknown;
}

interface PluginListOutput {
  readonly plugins?: unknown;
}

export interface DoctorReport {
  readonly ok: boolean;
  readonly compatibility: {
    readonly bbCli: string;
    readonly bbEngine: string;
    readonly pluginSdk: string;
  };
  readonly selectedBbCli?: Omit<SelectedBbCli, "env">;
  readonly host: {
    readonly version: string | null;
    readonly compatible: boolean;
  };
  readonly plugin: {
    readonly id: string;
    readonly found: boolean;
    readonly source: string | null;
    readonly rootDir: string | null;
    readonly sourceMatches: boolean;
    readonly version: string | null;
    readonly enabled: boolean | null;
    readonly status: string | null;
    readonly statusDetail: string | null;
    readonly appSdkVersion: string | null;
    readonly appCompatible: boolean | null;
  };
  readonly suggestedQuery: string | null;
  readonly checklist: readonly string[];
  readonly errors: readonly { readonly code: string; readonly message: string }[];
}

export interface DoctorOptions {
  readonly run?: CommandRunner;
  readonly env?: Readonly<NodeJS.ProcessEnv>;
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new ProcessError(
      "doctor_invalid_output",
      `${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function readOnlyCommand(
  selected: SelectedBbCli,
  run: CommandRunner,
  root: string,
  args: readonly string[],
  label: string,
): unknown {
  const result = run({
    file: selected.path,
    args,
    cwd: root,
    env: selected.env,
  });
  if (result.status !== 0 || result.error) {
    throw new ProcessError("doctor_host_unavailable", `${label} failed: ${processFailure(result)}`);
  }
  return parseJson(result.stdout, label);
}

function stringField(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function installedPlugin(value: unknown, pluginId: string): PluginListEntry | null {
  if (typeof value !== "object" || value === null) return null;
  const plugins = (value as PluginListOutput).plugins;
  if (!Array.isArray(plugins)) return null;
  return plugins.find((entry): entry is PluginListEntry =>
    typeof entry === "object"
    && entry !== null
    && (entry as PluginListEntry).id === pluginId
  ) ?? null;
}

function appSdkVersion(entry: PluginListEntry | null): string | null {
  if (typeof entry?.app !== "object" || entry.app === null) return null;
  const bundle = (entry.app as { readonly bundle?: unknown }).bundle;
  if (typeof bundle !== "object" || bundle === null) return null;
  return stringField((bundle as { readonly sdkVersion?: unknown }).sdkVersion);
}

function appCompatible(entry: PluginListEntry | null): boolean | null {
  if (typeof entry?.app !== "object" || entry.app === null) return null;
  const bundle = (entry.app as { readonly bundle?: unknown }).bundle;
  if (typeof bundle !== "object" || bundle === null) return null;
  const compatible = (bundle as { readonly compatible?: unknown }).compatible;
  return typeof compatible === "boolean" ? compatible : null;
}

function samePath(left: string, right: string | null): boolean {
  if (!right) return false;
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

/** Read supported host facts and suggest manual evidence. Never invokes plugin RPC. */
export function doctorProject(root: string, options: DoctorOptions = {}): DoctorReport {
  const project = discoverProject(root);
  const run = options.run ?? defaultCommandRunner;
  const errors: Array<{ code: string; message: string }> = [];
  let selected: SelectedBbCli | undefined;
  let hostVersion: string | null = null;
  let entry: PluginListEntry | null = null;
  try {
    selected = selectBbCli(
      root,
      options.env ?? process.env,
      compatibility.bbCliVersion,
      run,
    );
    const versionOutput = readOnlyCommand(
      selected,
      run,
      root,
      ["settings", "version", "--json"],
      "bb settings version --json",
    );
    hostVersion = typeof versionOutput === "object" && versionOutput !== null
      ? stringField((versionOutput as HostVersionOutput).currentVersion)
      : null;
    if (hostVersion === null) {
      errors.push({
        code: "doctor_host_version_unavailable",
        message: "bb settings version --json did not report currentVersion",
      });
    } else if (!isCompatibleHostVersion(hostVersion)) {
      errors.push({
        code: "doctor_host_incompatible",
        message: `connected bb ${hostVersion} does not satisfy ${compatibility.engines.bb}`,
      });
    }
    const listOutput = readOnlyCommand(
      selected,
      run,
      root,
      ["plugin", "list", "--json"],
      "bb plugin list --json",
    );
    entry = installedPlugin(listOutput, project.pluginId);
    if (!entry) {
      errors.push({
        code: "doctor_plugin_not_found",
        message: `plugin ${project.pluginId} is not installed on the connected bb host`,
      });
    }
  } catch (error) {
    const failure = error instanceof ProcessError
      ? error
      : new ProcessError("doctor_failed", error instanceof Error ? error.message : String(error));
    errors.push({ code: failure.code, message: failure.message });
  }

  const rootDir = stringField(entry?.rootDir);
  const sourceMatches = samePath(root, rootDir);
  if (entry && !sourceMatches) {
    errors.push({
      code: "doctor_plugin_source_mismatch",
      message: `installed plugin source ${JSON.stringify(rootDir)} does not match ${root}`,
    });
  }
  const status = stringField(entry?.status);
  if (entry && (entry.enabled !== true || status !== "running")) {
    errors.push({
      code: "doctor_plugin_not_running",
      message: `plugin ${project.pluginId} is enabled=${JSON.stringify(entry.enabled)} with status=${JSON.stringify(status)}`,
    });
  }
  const installedAppSdkVersion = appSdkVersion(entry);
  const installedAppCompatible = appCompatible(entry);
  if (
    entry
    && project.appEntry
    && (
      installedAppSdkVersion !== compatibility.pluginSdk.version
      || installedAppCompatible !== true
    )
  ) {
    errors.push({
      code: "doctor_plugin_app_incompatible",
      message: `plugin ${project.pluginId} app SDK is ${JSON.stringify(installedAppSdkVersion)} with compatible=${JSON.stringify(installedAppCompatible)}`,
    });
  }

  const query = project.modules
    .flatMap((module) => module.operations)
    .filter((operation) => operation.kind === "query" && operation.input !== null)
    .sort((left, right) => left.identity.localeCompare(right.identity))[0];
  const suggestedQuery = query ? operationInvokeCommand(query) : null;
  const surfaces = new Set(project.modules.flatMap((module) => module.surfaces));
  const checklist = [
    `Confirm ${project.pluginId} is running from this checkout: ${root}.`,
    ...(suggestedQuery
      ? [`Run the read-only query and inspect configured state: ${suggestedQuery}`]
      : ["No read-only invocation is available."]),
    ...(surfaces.has("nav-panel")
      ? ["Open the plugin navigation panel. Check loading, success, error, and narrow-width states."]
      : []),
    ...(surfaces.has("thread-panel")
      ? ["Open the thread panel action. Check loading, success, error, and narrow-width states."]
      : []),
    ...(project.appEntry
      ? ["Exercise one representative interaction in bb; a successful build is not UI evidence."]
      : []),
  ];

  return {
    ok: errors.length === 0,
    compatibility: {
      bbCli: compatibility.bbCliVersion,
      bbEngine: compatibility.engines.bb,
      pluginSdk: compatibility.pluginSdk.version,
    },
    ...(selected
      ? {
          selectedBbCli: {
            path: selected.path,
            source: selected.source,
            version: selected.version,
          },
        }
      : {}),
    host: {
      version: hostVersion,
      compatible: hostVersion ? isCompatibleHostVersion(hostVersion) : false,
    },
    plugin: {
      id: project.pluginId,
      found: entry !== null,
      source: stringField(entry?.source),
      rootDir,
      sourceMatches,
      version: stringField(entry?.version),
      enabled: typeof entry?.enabled === "boolean" ? entry.enabled : null,
      status,
      statusDetail: stringField(entry?.statusDetail),
      appSdkVersion: installedAppSdkVersion,
      appCompatible: installedAppCompatible,
    },
    suggestedQuery,
    checklist,
    errors,
  };
}

export function formatDoctor(report: DoctorReport): string {
  const lines = [
    report.ok ? "✓ bb-kit doctor passed" : "✗ bb-kit doctor found blockers",
    `Host: ${report.host.version ?? "unavailable"}`,
    `Plugin: ${report.plugin.id} (${report.plugin.status ?? "not found"})`,
    `Source: ${report.plugin.rootDir ?? "unavailable"}`,
  ];
  for (const error of report.errors) lines.push(`${error.code}: ${error.message}`);
  lines.push("", "Manual checklist");
  for (const [index, item] of report.checklist.entries()) {
    lines.push(`  ${index + 1}. ${item}`);
  }
  return lines.join("\n");
}
