import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { isExecutable, readTextOr, writeAtomic } from "./fsx.ts";
import {
  LaunchdPersistentService,
  SystemdPersistentService,
  type CommandResult,
  type CommandRunner,
  type PersistentService,
  type ServiceSnapshot,
} from "./persistent-service.ts";

export const TUNNEL_CONFIG_VERSION = 1 as const;

export interface TunnelDesiredConfigV1 {
  version: typeof TUNNEL_CONFIG_VERSION;
  corePort: number;
  cloudflaredPath: string;
  localApiKeyPath: string;
}

export type TunnelObservationV1 =
  | {
      version: typeof TUNNEL_CONFIG_VERSION;
      phase: "starting";
      ownerPid: number;
      sessionId: string;
      updatedAt: number;
    }
  | {
      version: typeof TUNNEL_CONFIG_VERSION;
      phase: "ready";
      ownerPid: number;
      sessionId: string;
      cloudflaredPid: number;
      publicOrigin: string;
      updatedAt: number;
    }
  | {
      version: typeof TUNNEL_CONFIG_VERSION;
      phase: "error";
      ownerPid: number;
      sessionId: string;
      detail: string;
      updatedAt: number;
    };

export type TunnelStatus =
  | { state: "disabled" }
  | { state: "missing-binary"; detail: string }
  | { state: "stopped"; reason: "core-stopped" | "disabled" }
  | { state: "stopping"; pid: number | null; detail: string }
  | { state: "starting"; pid: number | null; detail: string }
  | { state: "running-without-url"; pid: number; detail: string }
  | { state: "ready"; pid: number; openaiBaseUrl: string }
  | { state: "crashed"; lastExit: ServiceSnapshot["lastExit"]; detail: string };

export type CloudflaredDiscovery =
  | { state: "found"; path: string }
  | { state: "missing"; detail: string };

const COMMON_CLOUDFLARED_PATHS: Partial<Record<NodeJS.Platform, readonly string[]>> = {
  darwin: ["/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared"],
  linux: ["/usr/local/bin/cloudflared", "/usr/bin/cloudflared", "/snap/bin/cloudflared"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value < 65_536;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function discoverCloudflared(
  options: {
    path?: string;
    platform?: NodeJS.Platform;
    executable?: (path: string) => boolean;
    realpath?: (path: string) => string;
  } = {},
): CloudflaredDiscovery {
  const platform = options.platform ?? process.platform;
  const executable = options.executable ?? isExecutable;
  const canonicalPath = options.realpath ?? realpathSync;
  const pathEntries = (options.path ?? process.env.PATH ?? "")
    .split(delimiter)
    .filter((entry) => entry.length > 0)
    .map((entry) => resolve(entry, "cloudflared"));
  const candidates = [...pathEntries, ...(COMMON_CLOUDFLARED_PATHS[platform] ?? [])];
  for (const candidate of new Set(candidates)) {
    if (!isAbsolute(candidate) || !executable(candidate)) continue;
    try {
      return { state: "found", path: canonicalPath(candidate) };
    } catch {
      return { state: "found", path: candidate };
    }
  }
  const install =
    platform === "darwin"
      ? "Install it with `brew install cloudflared`, then disable and re-enable the setting."
      : "Install cloudflared on this host, then disable and re-enable the setting.";
  return { state: "missing", detail: `cloudflared was not found. ${install}` };
}

export function parseTunnelDesiredConfig(value: unknown): TunnelDesiredConfigV1 | null {
  if (!isRecord(value)) return null;
  if (value.version !== TUNNEL_CONFIG_VERSION || !isPort(value.corePort)) return null;
  if (typeof value.cloudflaredPath !== "string" || !isAbsolute(value.cloudflaredPath)) return null;
  if (typeof value.localApiKeyPath !== "string" || !isAbsolute(value.localApiKeyPath)) return null;
  return {
    version: TUNNEL_CONFIG_VERSION,
    corePort: value.corePort,
    cloudflaredPath: value.cloudflaredPath,
    localApiKeyPath: value.localApiKeyPath,
  };
}

export function renderTunnelDesiredConfig(config: TunnelDesiredConfigV1): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function tryCloudflareOrigin(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    !/^[a-z0-9-]+\.trycloudflare\.com$/i.test(parsed.hostname)
  ) {
    return null;
  }
  return parsed.origin;
}

export function extractTryCloudflareOrigin(output: string): string | null {
  for (const match of output.matchAll(
    /https:\/\/[a-z0-9-]+\.trycloudflare\.com\/?(?![a-z0-9.-])/gi,
  )) {
    const origin = tryCloudflareOrigin(match[0]);
    if (origin !== null) return origin;
  }
  return null;
}

export function parseTunnelObservation(value: unknown): TunnelObservationV1 | null {
  if (!isRecord(value)) return null;
  if (
    value.version !== TUNNEL_CONFIG_VERSION ||
    !isPositiveInteger(value.ownerPid) ||
    typeof value.sessionId !== "string" ||
    value.sessionId.length === 0 ||
    !isTimestamp(value.updatedAt)
  ) {
    return null;
  }
  const shared = {
    version: TUNNEL_CONFIG_VERSION,
    ownerPid: value.ownerPid,
    sessionId: value.sessionId,
    updatedAt: value.updatedAt,
  };
  if (value.phase === "starting") return { ...shared, phase: "starting" };
  if (value.phase === "error" && typeof value.detail === "string") {
    return { ...shared, phase: "error", detail: value.detail };
  }
  if (
    value.phase === "ready" &&
    isPositiveInteger(value.cloudflaredPid) &&
    typeof value.publicOrigin === "string"
  ) {
    const publicOrigin = tryCloudflareOrigin(value.publicOrigin);
    if (publicOrigin !== null) {
      return {
        ...shared,
        phase: "ready",
        cloudflaredPid: value.cloudflaredPid,
        publicOrigin,
      };
    }
  }
  return null;
}

export function readTunnelObservation(path: string): TunnelObservationV1 | null {
  const raw = readTextOr(path);
  if (raw === null) return null;
  try {
    return parseTunnelObservation(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function deriveTunnelStatus(options: {
  enabled: boolean;
  coreDesiredRunning: boolean;
  coreLoaded: boolean;
  discovery: CloudflaredDiscovery | null;
  preparationError: string | null;
  stopError?: string | null;
  service: ServiceSnapshot;
  observation: TunnelObservationV1 | null;
}): TunnelStatus {
  if (options.stopError) {
    return { state: "crashed", lastExit: options.service.lastExit, detail: options.stopError };
  }
  if (!options.enabled) {
    if (options.service.loaded || options.service.pid !== null) {
      return {
        state: "stopping",
        pid: options.service.pid,
        detail: "Waiting for the operating system to stop the public tunnel.",
      };
    }
    return { state: "disabled" };
  }
  if (options.discovery?.state === "missing") {
    return { state: "missing-binary", detail: options.discovery.detail };
  }
  if (options.preparationError !== null) {
    return { state: "crashed", lastExit: null, detail: options.preparationError };
  }
  if (!options.coreDesiredRunning || !options.coreLoaded) {
    return { state: "stopped", reason: "core-stopped" };
  }
  if (options.service.state === "crashed") {
    return {
      state: "crashed",
      lastExit: options.service.lastExit,
      detail: "The Cloudflare tunnel helper keeps exiting. Check the tunnel log.",
    };
  }
  const ownerPid = options.service.pid;
  if (ownerPid === null || !options.service.loaded) {
    return { state: "starting", pid: null, detail: "Waiting for the tunnel helper service." };
  }
  const observation = options.observation;
  if (observation === null || observation.ownerPid !== ownerPid) {
    return {
      state: "running-without-url",
      pid: ownerPid,
      detail: "Waiting for a fresh tunnel helper observation.",
    };
  }
  if (observation.phase === "starting") {
    return { state: "starting", pid: ownerPid, detail: "Cloudflare is assigning a hostname." };
  }
  if (observation.phase === "error") {
    return { state: "running-without-url", pid: ownerPid, detail: observation.detail };
  }
  return {
    state: "ready",
    pid: ownerPid,
    openaiBaseUrl: `${observation.publicOrigin}/v1`,
  };
}

export interface BundledTunnelRuntime {
  sourcePath: string;
  content: Buffer;
  sha256: string;
  targetPath: string;
}

export interface TunnelHostRuntime {
  executablePath: string;
  environment: Readonly<Record<string, string>>;
}

function canonicalPathOrOriginal(path: string, canonicalPath: (path: string) => string): string {
  try {
    return canonicalPath(path);
  } catch {
    return path;
  }
}

export function resolveTunnelHostRuntime(
  options: {
    platform?: NodeJS.Platform;
    execPath?: string;
    appImagePath?: string;
    electronVersion?: string;
    executable?: (path: string) => boolean;
    realpath?: (path: string) => string;
  } = {},
): TunnelHostRuntime {
  const platform = options.platform ?? process.platform;
  const executable = options.executable ?? isExecutable;
  const canonicalPath = options.realpath ?? realpathSync;
  const appImagePath = options.appImagePath ?? process.env.APPIMAGE;
  const preferredPath =
    platform === "linux" &&
    appImagePath !== undefined &&
    isAbsolute(appImagePath) &&
    executable(appImagePath)
      ? appImagePath
      : (options.execPath ?? process.execPath);
  return {
    executablePath: canonicalPathOrOriginal(preferredPath, canonicalPath),
    environment:
      (options.electronVersion ?? process.versions.electron) === undefined
        ? {}
        : { ELECTRON_RUN_AS_NODE: "1" },
  };
}

export function loadBundledTunnelRuntime(options: {
  runtimeDir: string;
  moduleUrl?: string;
}): BundledTunnelRuntime {
  const moduleDir = dirname(fileURLToPath(options.moduleUrl ?? import.meta.url));
  const sourcePath = [
    join(moduleDir, "cloudflare-tunnel-runtime.mjs"),
    join(moduleDir, "..", "lib", "cloudflare-tunnel-runtime.mjs"),
  ].find(existsSync);
  if (sourcePath === undefined) {
    throw new Error("the packaged Cloudflare tunnel helper source is missing");
  }
  const content = readFileSync(sourcePath);
  const sha256 = createHash("sha256").update(content).digest("hex");
  return {
    sourcePath,
    content,
    sha256,
    targetPath: join(options.runtimeDir, `cloudflare-tunnel-runtime-${sha256}.mjs`),
  };
}

export type RuntimeCommandRunner = (
  file: string,
  args: string[],
  environment: Readonly<Record<string, string>>,
) => Promise<CommandResult>;

function runCommand(
  file: string,
  args: string[],
  environment: Readonly<Record<string, string>>,
): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    execFile(
      file,
      args,
      {
        encoding: "utf8",
        env: { ...process.env, ...environment },
        timeout: 5_000,
        killSignal: "SIGKILL",
      },
      (error, stdout, stderr) => {
        const rawCode = (error as NodeJS.ErrnoException | null)?.code;
        resolveResult({
          code: typeof rawCode === "number" ? rawCode : error ? 1 : 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? error?.message ?? ""),
        });
      },
    );
  });
}

export async function installTunnelRuntime(options: {
  runtime: BundledTunnelRuntime;
  hostRuntime: TunnelHostRuntime;
  commandRunner?: RuntimeCommandRunner;
}): Promise<{ state: "ready"; runtimePath: string } | { state: "blocked"; detail: string }> {
  const runtimePath = options.runtime.targetPath;
  const installed = readTextOr(runtimePath);
  if (installed === null || !Buffer.from(installed).equals(options.runtime.content)) {
    writeAtomic(runtimePath, options.runtime.content, 0o700);
  }
  const result = await (options.commandRunner ?? runCommand)(
    options.hostRuntime.executablePath,
    [runtimePath, "helper", "--self-test"],
    options.hostRuntime.environment,
  );
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
    return {
      state: "blocked",
      detail: `${options.hostRuntime.executablePath} cannot run the Cloudflare tunnel helper: ${detail}`,
    };
  }
  return { state: "ready", runtimePath };
}

export function createCloudflareTunnelService(options: {
  label: string;
  definitionPath: string;
  runtimePath: string;
  hostRuntime: TunnelHostRuntime;
  configPath: string;
  observationPath: string;
  workingDirectory: string;
  logPath: string;
  readinessUrl: () => string;
  platform?: NodeJS.Platform;
  uid?: number;
  onChange?: (snapshot: ServiceSnapshot) => void;
  onError?: (error: unknown) => void;
  runCommand?: CommandRunner;
  fetchImpl?: typeof fetch;
  monitorIntervalMs?: number;
}): PersistentService {
  const platform = options.platform ?? process.platform;
  const program = {
    command: [
      options.hostRuntime.executablePath,
      options.runtimePath,
      "helper",
      "--config",
      options.configPath,
      "--observation",
      options.observationPath,
    ] as const,
    environment: options.hostRuntime.environment,
    workingDirectory: options.workingDirectory,
    logPath: options.logPath,
    readinessUrl: options.readinessUrl,
  };
  const shared = {
    label: options.label,
    program,
    isInstalled: () => existsSync(options.runtimePath) && existsSync(options.configPath),
    onChange: options.onChange,
    onError: options.onError,
    runCommand: options.runCommand,
    fetchImpl: options.fetchImpl,
    monitorIntervalMs: options.monitorIntervalMs,
    platform,
  };
  if (platform === "darwin") {
    if (options.uid === undefined) {
      throw new Error("Cloudflare tunnel launchd service requires a POSIX user id");
    }
    return new LaunchdPersistentService({
      ...shared,
      uid: options.uid,
      plistPath: options.definitionPath,
    });
  }
  if (platform === "linux") {
    return new SystemdPersistentService({
      ...shared,
      unitPath: options.definitionPath,
    });
  }
  throw new Error(`Cloudflare tunnel services are not supported on ${platform}`);
}

export async function monitorTunnelObservation(options: {
  path: string;
  signal: AbortSignal;
  onChange: () => void;
  intervalMs?: number;
}): Promise<void> {
  let previous = readTextOr(options.path);
  const intervalMs = options.intervalMs ?? 1_000;
  while (!options.signal.aborted) {
    try {
      await delay(intervalMs, undefined, { signal: options.signal });
    } catch (error) {
      if (!options.signal.aborted) throw error;
    }
    if (options.signal.aborted) break;
    const next = readTextOr(options.path);
    if (next === previous) continue;
    previous = next;
    options.onChange();
  }
}
