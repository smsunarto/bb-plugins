import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  AMP_ACP_EXECUTOR_ENV,
  AMP_AGENT,
  OBSOLETE_AMP_ORB_AGENT,
} from "../src/execution-target.ts";
import {
  AMP_LEGACY_RED_LOGO_SVG,
  AMP_LOGO_SVG,
} from "../src/amp-brand.ts";

/** Compatibility aliases for the original provider identity. */
export const AGENT_ID = AMP_AGENT.agentId;
export const PROVIDER_ID = AMP_AGENT.providerId;
export const OBSOLETE_ORB_AGENT_ID = OBSOLETE_AMP_ORB_AGENT.agentId;
export const OBSOLETE_ORB_PROVIDER_ID = OBSOLETE_AMP_ORB_AGENT.providerId;

/**
 * The one repair hint every "bridge bundle is missing" message must use, so the
 * CLI status line and the provisioning error must never disagree.
 *
 * `npm install` inside a source checkout of the plugin is actively harmful:
 * that tree is a Bun workspace, and the root package.json `overrides` entry
 * that swaps @ampcode/cli for the local stub only applies at the workspace
 * root. A leaf install pulls in the real @ampcode/cli, which @ampcode/sdk
 * resolves BEFORE AMP_CLI_PATH, silently breaking CLI resolution (see the root
 * package.json "comments" field and test/cli-stub.test.ts).
 */
export const BRIDGE_BUILD_HINT =
  "Reinstall the plugin with `bb plugin install npm:@smsunarto/bb-plugin-amp`. "
  + "From a source checkout, run `bun install` at the repository root "
  + "(never `npm install` inside the plugin), then `bun run build` in plugins/amp.";

export interface ProvisionPaths {
  dataDir: string;
  configPath: string;
  logoPath: string;
}

/** Everything needed to launch the bundled ACP bridge. */
export interface BridgeLaunch {
  /** Executable that runs the bridge (process.execPath at provision time). */
  node: string;
  /**
   * True when `node` is an Electron binary (bb's own) rather than a plain node.
   * Electron only behaves like node when ELECTRON_RUN_AS_NODE=1 is set; without
   * it, spawning bb's binary with a script argument launches the GUI instead of
   * running the bridge, and bb's ACP client sees a silent agent.
   */
  electron: boolean;
  /** Absolute path to the bundled bridge, <plugin dir>/dist/bridge.js. */
  bridge: string;
  /** Amp CLI executable, passed to the bridge via AMP_CLI_PATH. */
  amp: string;
}

/**
 * Decide which executable runs the bridge. The plugin host's own executable is
 * always present and version-compatible with the bundle, so it is preferred
 * over hunting for a system node; the only adjustment needed is the Electron
 * run-as-node flag when bb's host process is Electron rather than plain node.
 */
export function resolveNodeRuntime(
  execPath: string,
  platform: NodeJS.Platform = process.platform,
): { node: string; electron: boolean } {
  const base = execPath.split(/[\\/]/).pop() ?? "";
  const normalized = platform === "win32" ? base.toLowerCase() : base;
  const isPlainNode = normalized === "node" || normalized === "node.exe";
  return { node: execPath, electron: !isPlainNode };
}

interface CustomAgent extends Record<string, unknown> {
  id?: unknown;
  env?: unknown;
}

const AMP_NATIVE_SKILL_ROOTS = {
  user: [
    ".config/agents/skills",
    ".agents/skills",
    ".config/amp/skills",
    ".claude/skills",
  ],
  project: [
    ".agents/skills",
    ".claude/skills",
  ],
};

function customAgentEnv(agent: CustomAgent | undefined): Record<string, unknown> {
  return agent?.env !== null
    && typeof agent?.env === "object"
    && !Array.isArray(agent.env)
    ? (agent.env as Record<string, unknown>)
    : {};
}

function mergeManagedEnv(
  existingEnv: Record<string, unknown>,
  managedEnv: Record<string, unknown>,
  electron: boolean,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    ...existingEnv,
    ...managedEnv,
  };
  // Removed bridge option: do not leave the old provider-wide continuation
  // behavior enabled in previously provisioned entries.
  delete merged.AMP_ACP_CONTINUE_LATEST;
  // `/orb` now selects execution per Amp thread. Remove the obsolete
  // provider-wide discriminator from both migrated entries.
  delete merged[AMP_ACP_EXECUTOR_ENV];
  // Drop a stale run-as-node flag left by a previous Electron-hosted setup.
  if (!electron) delete merged.ELECTRON_RUN_AS_NODE;
  return merged;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findBinary(
  binaryName: string,
  extraDirectories: string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | null {
  const names = platform === "win32"
    ? [`${binaryName}.exe`, `${binaryName}.cmd`, binaryName]
    : [binaryName];
  const searchDirectories = (env.PATH ?? "").split(delimiter).filter(Boolean);
  searchDirectories.push(...extraDirectories);
  if (platform === "darwin") {
    searchDirectories.push("/opt/homebrew/bin", "/usr/local/bin");
  }
  for (const directory of new Set(searchDirectories)) {
    for (const name of names) {
      const candidate = join(directory, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Resolve the Amp CLI. The bundled bridge drives it through @ampcode/sdk,
 * which honors the AMP_CLI_PATH env var set on the managed entry.
 */
export function resolveAmpCli(
  env: NodeJS.ProcessEnv,
  home = homedir(),
  platform = process.platform,
): string | null {
  return findBinary(
    "amp",
    [
      join(home, ".local", "bin"),
      join(home, ".amp", "bin"),
      join(home, ".local", "share", "mise", "shims"),
    ],
    env,
    platform,
  );
}

function readConfig(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) return {};
  const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${configPath} must contain a JSON object; refusing to overwrite it`);
  }
  return parsed as Record<string, unknown>;
}

function writeAtomic(path: string, content: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.bb-plugin-amp-${process.pid}.tmp`;
  try {
    writeFileSync(temporary, content, "utf8");
    if (mode !== undefined) chmodSync(temporary, mode);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function writeManagedLogo(path: string): "written" | "updated" | "kept" {
  if (!existsSync(path)) {
    writeAtomic(path, AMP_LOGO_SVG);
    return "written";
  }
  if (readFileSync(path, "utf8") !== AMP_LEGACY_RED_LOGO_SVG) return "kept";
  writeAtomic(path, AMP_LOGO_SVG);
  return "updated";
}

/**
 * Managed customAcpAgents entry: node runs the bundled bridge, which speaks
 * ACP to bb and drives the Amp CLI (AMP_CLI_PATH) via @ampcode/sdk.
 *
 * No nativeReasoning block: Amp owns the default effort for each mode, and the
 * bridge deliberately omits a thought_level selector until bb can represent
 * that agent-managed default alongside explicit SDK effort overrides.
 * nativeSkillRoots lets bb index the direct user and project roots that Amp
 * scans itself; it does not change the ACP wire protocol or Amp execution.
 */
export function managedAgentEntry(
  launch: BridgeLaunch,
): Record<string, unknown> {
  const env: Record<string, string> = {
    AMP_CLI_PATH: launch.amp,
  };
  if (launch.electron) env.ELECTRON_RUN_AS_NODE = "1";
  return {
    id: AMP_AGENT.agentId,
    displayName: AMP_AGENT.displayName,
    command: launch.node,
    args: [launch.bridge],
    env,
    logo: "logos/amp.svg",
    nativeSkillRoots: AMP_NATIVE_SKILL_ROOTS,
  };
}

export function provisionInstallation(
  paths: ProvisionPaths,
  launch: BridgeLaunch,
): { changed: boolean; messages: string[] } {
  if (!isExecutable(launch.node)) {
    throw new Error(`Node executable not found or not executable: ${launch.node}`);
  }
  if (!existsSync(launch.bridge)) {
    throw new Error(
      `Bridge bundle not found: ${launch.bridge}. ${BRIDGE_BUILD_HINT}`,
    );
  }
  if (!isExecutable(launch.amp)) {
    throw new Error(`Amp CLI is not executable: ${launch.amp}`);
  }
  mkdirSync(paths.dataDir, { recursive: true });
  // The logo is a user-visible preference once installed. Migrate only the
  // exact legacy red asset that this plugin wrote; preserve customized logos.
  const logoResult = writeManagedLogo(paths.logoPath);

  const config = readConfig(paths.configPath);
  const agents: CustomAgent[] = Array.isArray(config.customAcpAgents)
    ? [...(config.customAcpAgents as CustomAgent[])]
    : [];
  const originalAgents = JSON.stringify(agents);
  const configMessages: string[] = [];
  const canonicalIndex = agents.findIndex((agent) => agent?.id === AGENT_ID);
  const obsoleteIndex = agents.findIndex(
    (agent) => agent?.id === OBSOLETE_ORB_AGENT_ID,
  );
  const canonical = canonicalIndex >= 0 ? agents[canonicalIndex] : undefined;
  const obsolete = obsoleteIndex >= 0 ? agents[obsoleteIndex] : undefined;
  const managed = managedAgentEntry(launch);
  const updated: CustomAgent = {
    ...obsolete,
    ...canonical,
    ...managed,
    env: mergeManagedEnv(
      {
        ...customAgentEnv(obsolete),
        ...customAgentEnv(canonical),
      },
      managed.env as Record<string, unknown>,
      launch.electron,
    ),
  };
  // bb's internal ACP launch type has permissionCli, but customAcpAgents does
  // not accept it. Remove entries written by the short-lived bridge workaround;
  // the bridge reads the resolved permission from bb's thread event instead.
  delete updated.permissionCli;

  if (canonicalIndex >= 0) {
    agents[canonicalIndex] = updated;
    configMessages.push(
      JSON.stringify(updated) === JSON.stringify(canonical)
        ? `custom ACP agent ${AGENT_ID} already up to date`
        : `updated custom ACP agent ${AGENT_ID}`,
    );
  } else if (obsoleteIndex >= 0) {
    agents[obsoleteIndex] = updated;
    configMessages.push(
      `migrated custom ACP agent ${OBSOLETE_ORB_AGENT_ID} to ${AGENT_ID} (${PROVIDER_ID})`,
    );
  } else {
    agents.push(updated);
    configMessages.push(`added custom ACP agent ${AGENT_ID} (${PROVIDER_ID})`);
  }

  const obsoleteCount = agents.filter(
    (agent) => agent?.id === OBSOLETE_ORB_AGENT_ID,
  ).length;
  if (obsoleteCount > 0) {
    const retained = agents.filter(
      (agent) => agent?.id !== OBSOLETE_ORB_AGENT_ID,
    );
    agents.splice(0, agents.length, ...retained);
    configMessages.push(
      `removed obsolete custom ACP agent ${OBSOLETE_ORB_AGENT_ID} (${OBSOLETE_ORB_PROVIDER_ID})`,
    );
  }

  const configChanged = JSON.stringify(agents) !== originalAgents;
  if (configChanged) {
    config.customAcpAgents = agents;
    writeAtomic(paths.configPath, `${JSON.stringify(config, null, "\t")}\n`);
  }
  return {
    changed: logoResult !== "kept" || configChanged,
    messages: [
      logoResult === "written"
        ? `wrote ${paths.logoPath}`
        : logoResult === "updated"
          ? `updated managed logo at ${paths.logoPath}`
          : `kept existing logo at ${paths.logoPath}`,
      ...configMessages,
    ],
  };
}

/**
 * Whether the managed entry should be written without the user asking.
 *
 * True when the entry is absent, still carries the obsolete Orb id, lacks the
 * managed native skill roots, or names a runtime, bridge, or Amp CLI that this
 * installation can no longer run. A working entry is left alone, so an added
 * env var or a hand-picked Amp binary survives every restart. An unreadable
 * config throws so the background service can report the failure without
 * modifying the file.
 */
export function needsProvisioning(
  paths: ProvisionPaths,
  launch: Pick<BridgeLaunch, "node" | "bridge">,
): boolean {
  const config = readConfig(paths.configPath);
  const agents: CustomAgent[] = Array.isArray(config.customAcpAgents)
    ? (config.customAcpAgents as CustomAgent[])
    : [];
  if (agents.some((agent) => agent?.id === OBSOLETE_ORB_AGENT_ID)) return true;
  const entry = agents.find((agent) => agent?.id === AGENT_ID);
  if (entry === undefined) return true;
  if (entry.command !== launch.node) return true;
  const args = entry.args;
  if (!Array.isArray(args) || args.length !== 1 || args[0] !== launch.bridge) {
    return true;
  }
  if ("permissionCli" in entry) return true;
  if (
    JSON.stringify(entry.nativeSkillRoots)
      !== JSON.stringify(AMP_NATIVE_SKILL_ROOTS)
  ) {
    return true;
  }
  const recordedCli = customAgentEnv(entry).AMP_CLI_PATH;
  return typeof recordedCli !== "string" || !isExecutable(recordedCli);
}

export function inspectInstallation(paths: ProvisionPaths): {
  configured: boolean;
  obsoleteOrbConfigured: boolean;
  error?: string;
} {
  try {
    const config = readConfig(paths.configPath);
    const agents = Array.isArray(config.customAcpAgents)
      ? (config.customAcpAgents as CustomAgent[])
      : [];
    const configured = agents.some(
      (agent) => agent?.id === AMP_AGENT.agentId,
    );
    const obsoleteOrbConfigured = agents.some(
      (agent) => agent?.id === OBSOLETE_AMP_ORB_AGENT.agentId,
    );
    return {
      configured,
      obsoleteOrbConfigured,
    };
  } catch (error) {
    return {
      configured: false,
      obsoleteOrbConfigured: false,
      error: String(error),
    };
  }
}
