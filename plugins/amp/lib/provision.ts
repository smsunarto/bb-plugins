import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";
import { homedir } from "node:os";
import { AMP_AGENT } from "../src/execution-target.ts";

/**
 * The one repair hint every "bridge bundle is missing" message must use, so the
 * CLI status line and the registration error must never disagree.
 *
 * `npm install` inside a source checkout of the plugin is actively harmful:
 * that tree is a Bun workspace, and the root package.json `overrides` entry
 * that swaps @ampcode/cli for the local stub only applies at the workspace
 * root. A leaf install pulls in the real @ampcode/cli, which @ampcode/sdk
 * resolves BEFORE AMP_CLI_PATH, silently breaking CLI resolution (see the root
 * package.json "comments" field and test/cli-stub.test.ts).
 */
export const BRIDGE_BUILD_HINT =
  "Reinstall the plugin with `bb plugin install npm:@smsunarto/bb-plugin-amp`. " +
  "From a source checkout, run `bun install` at the repository root " +
  "(never `npm install` inside the plugin), then `bun run build` in plugins/amp.";

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

/**
 * The direct user and project skill roots that Amp scans itself, declared on
 * the launch spec so bb can index them; they do not change the ACP wire
 * protocol or Amp execution.
 */
export const AMP_NATIVE_SKILL_ROOTS = {
  user: [".config/agents/skills", ".agents/skills", ".config/amp/skills", ".claude/skills"],
  project: [".agents/skills", ".claude/skills"],
};

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
  const names =
    platform === "win32" ? [`${binaryName}.exe`, `${binaryName}.cmd`, binaryName] : [binaryName];
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
 * Resolve the Amp CLI. The bundled bridge spawns it directly; the
 * registration passes this resolved path down in providerOptions.
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

export interface AmpCliLaunch {
  command: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Resolve the same Amp executable and environment that the registered launch
 * spec names. `ampCliPath` is the path the registration resolved at load; a
 * stale or null one falls back to a fresh lookup.
 */
export function resolveAmpCliLaunch(
  ampCliPath: string | null,
  baseEnv: NodeJS.ProcessEnv = process.env,
): AmpCliLaunch | null {
  const command =
    ampCliPath !== null && isExecutable(ampCliPath) ? ampCliPath : resolveAmpCli(baseEnv);
  if (command === null) return null;
  return {
    command,
    env: {
      ...baseEnv,
      AMP_CLI_PATH: command,
    },
  };
}

function readConfig(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) return {};
  const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${configPath} must contain a JSON object; refusing to overwrite it`);
  }
  return parsed as Record<string, unknown>;
}

function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.bb-plugin-amp-${process.pid}.tmp`;
  try {
    writeFileSync(temporary, content, "utf8");
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export interface LegacyConfigPaths {
  configPath: string;
  logoPath: string;
}

const MANAGED_ENTRY_KEYS = new Set([
  "id",
  "displayName",
  "command",
  "args",
  "env",
  "logo",
  "nativeSkillRoots",
]);
const MANAGED_ENV_KEYS = new Set(["AMP_CLI_PATH", "ELECTRON_RUN_AS_NODE"]);
const MANAGED_LOGO = "logos/amp.svg";

/**
 * Which parts of a legacy customAcpAgents "amp" entry a user customized.
 *
 * Empty means the entry is purely plugin-managed and safe to remove. The match
 * is by SHAPE, not string equality: every installed plugin version rewrote the
 * bridge path with its own plugin-cache location, and the command is a plain
 * node on some machines and bb's Electron binary on others, so neither is
 * compared against current values. Anything the old provisioning never wrote —
 * an extra entry key, an extra env var, a changed logo, skill roots, or
 * display name — is a customization worth preserving.
 */
export function legacyEntryDeviations(entry: Record<string, unknown>): string[] {
  const deviations: string[] = [];
  for (const key of Object.keys(entry)) {
    if (!MANAGED_ENTRY_KEYS.has(key)) deviations.push(key);
  }
  const args = entry.args;
  if (
    !Array.isArray(args) ||
    args.length !== 1 ||
    typeof args[0] !== "string" ||
    basename(args[0]) !== "bridge.js"
  ) {
    deviations.push("args");
  }
  const env = entry.env;
  if (env !== undefined) {
    if (env === null || typeof env !== "object" || Array.isArray(env)) {
      deviations.push("env");
    } else {
      for (const key of Object.keys(env)) {
        if (!MANAGED_ENV_KEYS.has(key)) deviations.push(`env.${key}`);
      }
    }
  }
  if (entry.displayName !== undefined && entry.displayName !== AMP_AGENT.displayName) {
    deviations.push("displayName");
  }
  if (entry.logo !== undefined && entry.logo !== MANAGED_LOGO) {
    deviations.push("logo");
  }
  if (
    entry.nativeSkillRoots !== undefined &&
    JSON.stringify(entry.nativeSkillRoots) !== JSON.stringify(AMP_NATIVE_SKILL_ROOTS)
  ) {
    deviations.push("nativeSkillRoots");
  }
  return deviations;
}

export type LegacyEntryInspection =
  | { entry: "absent" }
  | { entry: "managed" }
  | { entry: "customized"; deviations: string[] };

/** Report the legacy entry's state without modifying anything. */
export function inspectLegacyAmpEntry(configPath: string): LegacyEntryInspection {
  const config = readConfig(configPath);
  const agents = Array.isArray(config.customAcpAgents)
    ? (config.customAcpAgents as Record<string, unknown>[])
    : [];
  const entry = agents.find((agent) => agent?.id === AMP_AGENT.agentId);
  if (entry === undefined) return { entry: "absent" };
  const deviations = legacyEntryDeviations(entry);
  return deviations.length === 0 ? { entry: "managed" } : { entry: "customized", deviations };
}

export type LegacyCleanupResult =
  | { kind: "clean" }
  | { kind: "removed" }
  | { kind: "kept"; deviations: string[] };

/**
 * Remove the legacy plugin-managed customAcpAgents entry, once. A legacy entry
 * shadows the plugin registration with the same id, so removal is required,
 * not cosmetic — but only a purely plugin-managed entry is touched; a
 * customized one is reported and left for the user. Idempotent: with no "amp"
 * entry left, nothing is read beyond the config and nothing is written.
 */
export function cleanupLegacyAmpEntry(paths: LegacyConfigPaths): LegacyCleanupResult {
  const config = readConfig(paths.configPath);
  const agents = Array.isArray(config.customAcpAgents)
    ? (config.customAcpAgents as Record<string, unknown>[])
    : [];
  const entry = agents.find((agent) => agent?.id === AMP_AGENT.agentId);
  if (entry === undefined) return { kind: "clean" };
  const deviations = legacyEntryDeviations(entry);
  if (deviations.length > 0) return { kind: "kept", deviations };
  config.customAcpAgents = agents.filter((agent) => agent !== entry);
  writeAtomic(paths.configPath, `${JSON.stringify(config, null, "\t")}\n`);
  try {
    rmSync(paths.logoPath, { force: true });
  } catch {
    // The config write is what matters; a leftover logo file is inert.
  }
  return { kind: "removed" };
}
