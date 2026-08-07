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

export const AGENT_ID = "amp";
export const PROVIDER_ID = `acp-${AGENT_ID}`;

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

// Official Amp mark, copied from the hand-written ~/.bb/amp-logo.svg.
const LOGO = `<svg width="21" height="21" viewBox="0 0 21 21" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M3.76879 18.3015L8.49839 13.505L10.2196 20.0399L12.72 19.3561L10.2288 9.86749L0.890876 7.33844L0.22594 9.89331L6.65134 11.6388L1.94138 16.4282L3.76879 18.3015Z" fill="#F34E3F"/>
<path d="M17.4074 12.7414L19.9078 12.0575L17.4167 2.56897L8.07873 0.0399246L7.4138 2.5948L15.2992 4.73685L17.4074 12.7414Z" fill="#F34E3F"/>
<path d="M13.8184 16.3883L16.3188 15.7044L13.8276 6.21588L4.48971 3.68683L3.82477 6.24171L11.7101 8.38376L13.8184 16.3883Z" fill="#F34E3F"/>
</svg>
`;

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

function writeIfChanged(path: string, content: string): boolean {
  if (existsSync(path) && readFileSync(path, "utf8") === content) return false;
  writeAtomic(path, content);
  return true;
}

/**
 * Managed customAcpAgents entry: node runs the bundled bridge, which speaks
 * ACP to bb and drives the Amp CLI (AMP_CLI_PATH) via @ampcode/sdk.
 *
 * No nativeReasoning block: the bridge exposes a `category: "thought_level"`
 * config option (id "effort") over ACP, which bb binds to its per-model
 * reasoning-effort picker directly; nativeReasoning is only consulted when no
 * such option exists.
 */
export function managedAgentEntry(launch: BridgeLaunch): Record<string, unknown> {
  const env: Record<string, string> = { AMP_CLI_PATH: launch.amp };
  if (launch.electron) env.ELECTRON_RUN_AS_NODE = "1";
  return {
    id: AGENT_ID,
    displayName: "Amp",
    command: launch.node,
    args: [launch.bridge],
    env,
    logo: "logos/amp.svg",
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
      `Bridge bundle not found: ${launch.bridge}. `
        + `Run "npm install && npm run build" in ${dirname(dirname(launch.bridge))} first.`,
    );
  }
  if (!isExecutable(launch.amp)) {
    throw new Error(`Amp CLI is not executable: ${launch.amp}`);
  }
  mkdirSync(paths.dataDir, { recursive: true });
  const logoChanged = writeIfChanged(paths.logoPath, LOGO);

  const config = readConfig(paths.configPath);
  const agents: CustomAgent[] = Array.isArray(config.customAcpAgents)
    ? [...(config.customAcpAgents as CustomAgent[])]
    : [];
  const entry = managedAgentEntry(launch);
  const index = agents.findIndex((agent) => agent?.id === AGENT_ID);
  let configChanged = false;
  let configMessage: string;
  if (index < 0) {
    agents.push(entry);
    configChanged = true;
    configMessage = `added custom ACP agent ${AGENT_ID} (${PROVIDER_ID})`;
  } else {
    const existing = agents[index];
    const existingEnv = existing.env !== null
      && typeof existing.env === "object"
      && !Array.isArray(existing.env)
      ? (existing.env as Record<string, unknown>)
      : {};
    const mergedEnv: Record<string, unknown> = {
      ...existingEnv,
      ...(entry.env as Record<string, unknown>),
    };
    // Drop a stale run-as-node flag left by a previous Electron-hosted setup.
    if (!launch.electron) delete mergedEnv.ELECTRON_RUN_AS_NODE;
    const updated = { ...existing, ...entry, env: mergedEnv };
    configChanged = JSON.stringify(updated) !== JSON.stringify(existing);
    agents[index] = updated;
    configMessage = configChanged
      ? `updated custom ACP agent ${AGENT_ID}`
      : `custom ACP agent ${AGENT_ID} already up to date`;
  }
  if (configChanged) {
    config.customAcpAgents = agents;
    writeAtomic(paths.configPath, `${JSON.stringify(config, null, "\t")}\n`);
  }
  return {
    changed: logoChanged || configChanged,
    messages: [
      logoChanged ? `wrote ${paths.logoPath}` : `logo already up to date at ${paths.logoPath}`,
      configMessage,
    ],
  };
}

export function inspectInstallation(paths: ProvisionPaths): {
  configured: boolean;
  error?: string;
} {
  try {
    const config = readConfig(paths.configPath);
    const configured = Array.isArray(config.customAcpAgents)
      && (config.customAcpAgents as CustomAgent[]).some((agent) => agent?.id === AGENT_ID);
    return { configured };
  } catch (error) {
    return { configured: false, error: String(error) };
  }
}
