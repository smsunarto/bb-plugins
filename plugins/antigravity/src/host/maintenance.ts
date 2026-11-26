import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { devNull, homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  experimental_clampPercent,
  experimental_compareVersions,
  experimental_downloadedInstallerCommand,
  experimental_killPortableProcess,
  experimental_resolveExecutablePath,
  experimental_spawnPortableProcess,
  experimental_versionFrom,
  type ProviderInstallationCommand,
  type ProviderInstallationRunResult,
  type ProviderInstallationStatus,
  type ProviderUsageResult,
  type ProviderUsageWindow,
} from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";

/** 1.1.11 answers `/usage` in print mode; 1.1.12 also answers `/help`, so both are stable. */
export const MIN_USAGE_VERSION = "1.1.12";
export const ANTIGRAVITY_LOGIN_COMMAND = "agy acp --login";
export const ANTIGRAVITY_INSTALL_SCRIPT_URL = "https://antigravity.google/cli/install.sh";

const USAGE_CACHE_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 25_000;
const VERSION_TIMEOUT_MS = 5_000;
const KILL_GRACE_MS = 1_000;
const DRAIN_MS = 500;
const SIGNED_OUT_MARKER = "Authentication required";
const BROWSER_OPENERS = ["open", "xdg-open", "x-www-browser", "www-browser"] as const;

const ENV_KEYS = new Set([
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "TZ",
  "TMPDIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "SYSTEMROOT",
  "COMSPEC",
  "PATHEXT",
]);
const ENV_PREFIXES = ["LC_", "XDG_", "AGY_", "GEMINI_", "GOOGLE_"] as const;

const WINDOWS = new Map<string, { label: string; order: number }>([
  ["5h", { label: "5-hour", order: 0 }],
  ["daily", { label: "daily", order: 1 }],
  ["weekly", { label: "weekly", order: 2 }],
]);

const bucketSchema = z.object({
  name: z.string(),
  window: z.string().optional(),
  // agy tags this `omitempty`, so an exhausted bucket (0 left) omits it.
  remaining_fraction: z.number().min(0).max(1).optional(),
  reset_time: z.string().optional(),
});

const usagePayloadSchema = z.object({
  status: z.literal("SUCCESS"),
  command: z.object({
    name: z.literal("usage"),
    data: z.object({
      groups: z
        .array(
          z.object({
            name: z.string(),
            buckets: z.array(bucketSchema).optional(),
          }),
        )
        .optional(),
    }),
  }),
});

const agySettingsSchema = z
  .object({
    modelProvider: z.string().optional(),
  })
  .passthrough();

const geminiConfigSchema = z
  .object({
    userSettings: z
      .object({
        enableAdc: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type ParsedAntigravityUsage =
  | { kind: "ok"; windows: ProviderUsageWindow[] }
  | { kind: "unsafe" }
  | { kind: "failed" };

export type AntigravityCliUsageProbe =
  | { status: "ok"; windows: ProviderUsageWindow[] }
  | { status: "not_installed" }
  | { status: "unauthenticated" }
  | { status: "no_quota" }
  | { status: "error"; message: string };

interface CommandRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  signedOut: boolean;
  timedOut: boolean;
}

export function resolveAntigravityCommand(
  configuredCommand: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromConfig = configuredCommand?.trim();
  if (fromConfig && fromConfig !== "agy") return fromConfig;
  const fromEnv = env.BB_ANTIGRAVITY_EXECUTABLE?.trim();
  return fromEnv || fromConfig || "agy";
}

export function buildSafeAgyEnv(
  pathValue: string | undefined,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (
      value !== undefined &&
      (ENV_KEYS.has(key) || ENV_PREFIXES.some((prefix) => key.startsWith(prefix)))
    ) {
      env[key] = value;
    }
  }
  return {
    ...env,
    ...(pathValue === undefined ? {} : { PATH: pathValue }),
    AGY_CLI_DISABLE_AUTO_UPDATE: "true",
  };
}

function groupLabel(name: string): string {
  return (
    name
      .replace(/\s+models$/iu, "")
      .replace(/\s+and\s+/giu, "/")
      .trim() || name
  );
}

function normalizeResetTime(value: string | undefined): string | null {
  if (value === undefined) return null;
  const timestamp = Date.parse(value);
  // agy reports a bucket with no scheduled reset as the Unix epoch.
  return Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toISOString() : null;
}

function isUnsafeUsageEnvelope(body: Record<string, unknown>): boolean {
  if ((body["num_turns"] ?? 0) !== 0 || (body["conversation_id"] ?? "") !== "") return true;
  const command = body["command"];
  if (command === undefined || command === null) return body["status"] === "SUCCESS";
  return typeof command !== "object" || (command as { name?: unknown }).name !== "usage";
}

export function parseAntigravityUsageBody(body: unknown): ParsedAntigravityUsage {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { kind: "failed" };
  }
  if (isUnsafeUsageEnvelope(body as Record<string, unknown>)) {
    return { kind: "unsafe" };
  }
  const parsed = usagePayloadSchema.safeParse(body);
  if (!parsed.success) {
    return { kind: "failed" };
  }

  const windows: ProviderUsageWindow[] = [];
  for (const group of parsed.data.command.data.groups ?? []) {
    const orderedBuckets = [...(group.buckets ?? [])].sort((left, right) => {
      const leftOrder = WINDOWS.get(left.window ?? "")?.order ?? 99;
      const rightOrder = WINDOWS.get(right.window ?? "")?.order ?? 99;
      return leftOrder - rightOrder;
    });
    for (const bucket of orderedBuckets) {
      const known = WINDOWS.get(bucket.window ?? "");
      windows.push({
        label: `${groupLabel(group.name)} ${known?.label ?? bucket.name}`,
        usedPercent: experimental_clampPercent((1 - (bucket.remaining_fraction ?? 0)) * 100),
        resetsAt: normalizeResetTime(bucket.reset_time),
      });
    }
  }
  return { kind: "ok", windows };
}

export function supportsPrintUsage(version: string | null): boolean {
  if (version === null) return false;
  return experimental_compareVersions(version, MIN_USAGE_VERSION) >= 0;
}

function runBoundedProcess(args: {
  command: string;
  commandArgs: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  stopOnSignedOut?: boolean;
}): Promise<CommandRunResult> {
  return new Promise((resolve) => {
    const child = experimental_spawnPortableProcess({
      command: args.command,
      args: [...args.commandArgs],
      cwd: args.cwd,
      env: args.env,
    });
    child.stdin?.end();
    let stdout = "";
    let stderr = "";
    let signedOut = false;
    let timedOut = false;
    let settled = false;
    let stopping = false;
    let exitCode: number | null = null;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const later = (ms: number, fn: () => void) => timers.push(setTimeout(fn, Math.max(0, ms)));

    const settle = (code: number | null) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ code, stdout, stderr, signedOut, timedOut });
    };

    const stop = () => {
      if (stopping || settled) return;
      stopping = true;
      void experimental_killPortableProcess(child, "SIGTERM");
      later(KILL_GRACE_MS, () => {
        void experimental_killPortableProcess(child, "SIGKILL");
        later(DRAIN_MS, () => settle(exitCode));
      });
    };

    later(args.timeoutMs, () => {
      timedOut = true;
      stop();
    });

    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      if (stdout.length < 1_048_576) stdout += chunk;
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4096);
      if (args.stopOnSignedOut && !signedOut && stderr.includes(SIGNED_OUT_MARKER)) {
        signedOut = true;
        stop();
      }
    });
    child.on("error", () => settle(null));
    child.on("close", (code) => settle(code));
    child.on("exit", (code) => {
      exitCode = code;
      later(DRAIN_MS, () => settle(code));
    });
  });
}

/**
 * Prevents a signed-out `agy` process from opening a browser tab by shadowing
 * OS browser openers on a temporary private directory prepended to PATH.
 */
export async function withoutBrowserOpeners<T>(
  run: (cwd: string, pathValue: string | undefined) => Promise<T>,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  if (process.platform === "win32") {
    return run(tmpdir(), sourceEnv.PATH);
  }
  const dir = await mkdtemp(join(tmpdir(), "bb-antigravity-probe-"));
  try {
    await Promise.all(
      BROWSER_OPENERS.map((name) =>
        writeFile(join(dir, name), "#!/bin/sh\nexit 0\n", { mode: 0o700 }),
      ),
    );
    const pathValue = [dir, sourceEnv.PATH].filter(Boolean).join(delimiter);
    return await run(dir, pathValue);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function readAntigravityCliVersion(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const result = await runBoundedProcess({
    command,
    commandArgs: ["--version"],
    cwd: tmpdir(),
    env: buildSafeAgyEnv(env.PATH, env),
    timeoutMs: VERSION_TIMEOUT_MS,
  });
  if (result.timedOut || result.code !== 0) return null;
  return experimental_versionFrom(`${result.stdout}\n${result.stderr}`);
}

export async function hasStaticCredentialConfig(args: {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const env = args.env ?? process.env;
  const home = args.homeDir ?? homedir();
  if (env.AGY_ADC_AUTH === "true") {
    return true;
  }
  if (typeof env.GEMINI_API_KEY === "string" && env.GEMINI_API_KEY.trim() !== "") {
    try {
      const raw = JSON.parse(
        await readFile(join(home, ".gemini", "antigravity-cli", "settings.json"), "utf8"),
      );
      const settings = agySettingsSchema.safeParse(raw);
      if (settings.success && settings.data.modelProvider === "gemini") {
        return true;
      }
    } catch {
      // No settings file or unreadable; fall through.
    }
  }
  try {
    const raw = JSON.parse(await readFile(join(home, ".gemini", "config", "config.json"), "utf8"));
    const config = geminiConfigSchema.safeParse(raw);
    if (config.success && config.data.userSettings?.enableAdc === true) {
      return true;
    }
  } catch {
    // No config file or unreadable; fall through.
  }
  return false;
}

export function antigravityInstallerCommand(): ProviderInstallationCommand {
  return experimental_downloadedInstallerCommand(ANTIGRAVITY_INSTALL_SCRIPT_URL);
}

export function antigravityUpdateCommand(command: string): ProviderInstallationCommand {
  return {
    command,
    args: ["update"],
    displayCommand: "agy update",
  };
}

export async function getAntigravityInstallationStatus(args: {
  command: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ProviderInstallationStatus> {
  const resolved = await experimental_resolveExecutablePath(args.command);
  const installed = resolved !== null;
  const currentVersion = installed ? await readAntigravityCliVersion(resolved, args.env) : null;
  const installer = antigravityInstallerCommand();
  return {
    executableName: args.command,
    executablePath: resolved,
    installed,
    installSource: installed ? "external" : "notInstalled",
    currentVersion,
    latestVersion: null,
    minimumSupportedVersion: null,
    npmPackageName: null,
    npmGlobalPackageVersion: null,
    installAction: installed
      ? {
          kind: "update",
          label: "Update",
          command: "agy update",
        }
      : {
          kind: "install",
          label: "Install",
          command: installer.displayCommand,
        },
    needsUpdate: false,
    versionUnsupported: false,
  };
}

export async function getAntigravityInstallationRun(args: {
  command: string;
  action: "install" | "update";
  env?: NodeJS.ProcessEnv;
}): Promise<ProviderInstallationRunResult> {
  const status = await getAntigravityInstallationStatus(args);
  if (args.action === "install") {
    if (status.installed) {
      return {
        available: false,
        message: `${args.command} is already installed.`,
      };
    }
    return {
      available: true,
      command: antigravityInstallerCommand(),
      verification: { kind: "installed" },
    };
  }
  if (!status.installed || status.executablePath === null) {
    return {
      available: false,
      message: `${args.command} is not installed on this host.`,
    };
  }
  return {
    available: true,
    command: antigravityUpdateCommand(status.executablePath),
    verification: { kind: "installed" },
  };
}

interface CachedProbe {
  command: string;
  at: number;
  probe: AntigravityCliUsageProbe;
}

export interface AntigravityMaintenanceController {
  probeUsage(command: string, options?: { force?: boolean }): Promise<AntigravityCliUsageProbe>;
  readAccount(command: string): Promise<{ email: string | null } | null>;
  readUsage(command: string): Promise<ProviderUsageResult>;
  probeModelsOutput(command: string): Promise<string | null>;
}

export function createAntigravityMaintenanceController(deps?: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  now?: () => number;
}): AntigravityMaintenanceController {
  const env = deps?.env ?? process.env;
  const homeDir = deps?.homeDir ?? homedir();
  const now = deps?.now ?? Date.now;
  let cachedUsage: CachedProbe | null = null;
  let inFlightUsage: Promise<AntigravityCliUsageProbe> | null = null;
  let unsafeDisabled = false;

  async function runUsageProbe(command: string): Promise<AntigravityCliUsageProbe> {
    const resolved = await experimental_resolveExecutablePath(command);
    if (resolved === null) return { status: "not_installed" };
    if (unsafeDisabled) {
      return {
        status: "error",
        message: "Antigravity CLI did not handle /usage as a local command.",
      };
    }
    const version = await readAntigravityCliVersion(resolved, env);
    if (!supportsPrintUsage(version)) {
      return {
        status: "error",
        message: `Antigravity CLI ${version ?? "unknown"} is older than ${MIN_USAGE_VERSION}; update agy to inspect quota.`,
      };
    }
    return withoutBrowserOpeners(async (cwd, pathValue) => {
      const result = await runBoundedProcess({
        command: resolved,
        commandArgs: ["-p", "/usage", "--output-format", "json", "--log-file", devNull],
        cwd,
        env: buildSafeAgyEnv(pathValue, env),
        timeoutMs: PROBE_TIMEOUT_MS,
        stopOnSignedOut: true,
      });
      if (result.signedOut) return { status: "unauthenticated" };
      if (result.timedOut) {
        return { status: "error", message: "Antigravity quota check timed out." };
      }
      // agy exits 2 when the sign-in has no account quota (e.g. GEMINI_API_KEY).
      if (result.code === 2) return { status: "no_quota" };
      if (result.code !== 0) {
        return {
          status: "error",
          message: `Antigravity quota check exited with code ${String(result.code)}.`,
        };
      }
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(result.stdout);
      } catch {
        return { status: "error", message: "Antigravity quota output was not valid JSON." };
      }
      const parsed = parseAntigravityUsageBody(parsedJson);
      if (parsed.kind === "unsafe") {
        unsafeDisabled = true;
        return {
          status: "error",
          message: "Antigravity CLI did not handle /usage as a local command.",
        };
      }
      if (parsed.kind === "failed") {
        return { status: "error", message: "Antigravity quota response was malformed." };
      }
      return { status: "ok", windows: parsed.windows };
    }, env);
  }

  async function probeUsage(
    command: string,
    options?: { force?: boolean },
  ): Promise<AntigravityCliUsageProbe> {
    if (
      !options?.force &&
      cachedUsage !== null &&
      cachedUsage.command === command &&
      now() - cachedUsage.at < USAGE_CACHE_TTL_MS
    ) {
      return cachedUsage.probe;
    }
    if (inFlightUsage !== null) return inFlightUsage;
    const promise = runUsageProbe(command)
      .then((probe) => {
        cachedUsage = { command, at: now(), probe };
        return probe;
      })
      .finally(() => {
        inFlightUsage = null;
      });
    inFlightUsage = promise;
    return promise;
  }

  async function readAccount(command: string): Promise<{ email: string | null } | null> {
    if (await hasStaticCredentialConfig({ homeDir, env })) {
      return { email: null };
    }
    const probe = await probeUsage(command);
    switch (probe.status) {
      case "ok":
      case "no_quota":
        return { email: null };
      case "unauthenticated":
        return null;
      case "not_installed":
        return null;
      case "error":
        throw new Error(probe.message);
    }
  }

  async function readUsage(command: string): Promise<ProviderUsageResult> {
    const probe = await probeUsage(command, { force: true });
    switch (probe.status) {
      case "not_installed":
        return { supported: true, usage: { status: "not_installed" } };
      case "unauthenticated":
        return { supported: true, usage: { status: "unauthenticated" } };
      case "no_quota":
        return {
          supported: true,
          usage: {
            status: "ok",
            accountEmail: null,
            planLabel: null,
            windows: [],
          },
        };
      case "ok":
        return {
          supported: true,
          usage: {
            status: "ok",
            accountEmail: null,
            planLabel: null,
            windows: probe.windows,
          },
        };
      case "error":
        return {
          supported: true,
          usage: {
            status: "error",
            accountEmail: null,
            planLabel: null,
            message: probe.message,
          },
        };
    }
  }

  async function probeModelsOutput(command: string): Promise<string | null> {
    const resolved = await experimental_resolveExecutablePath(command);
    if (resolved === null) return null;
    return withoutBrowserOpeners(async (cwd, pathValue) => {
      const result = await runBoundedProcess({
        command: resolved,
        commandArgs: ["models"],
        cwd,
        env: buildSafeAgyEnv(pathValue, env),
        timeoutMs: 6_000,
        stopOnSignedOut: true,
      });
      if (result.signedOut || result.timedOut || result.code !== 0) return null;
      return result.stdout;
    }, env);
  }

  return {
    probeUsage,
    readAccount,
    readUsage,
    probeModelsOutput,
  };
}
