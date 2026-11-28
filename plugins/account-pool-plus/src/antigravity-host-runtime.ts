import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { z } from "zod";
import type { AntigravityUsageProbe, AntigravityUsageWindow } from "./antigravity-host-contract.js";

const APP_DATA_DIR = "antigravity-cli";
const PROFILES_SUBPATH = [".bb-plugins", "account-pool-plus", "antigravity-profiles"] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const AUTHORIZE_URL_PATTERN = /https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?[^\s]+/u;
const LOGIN_START_TIMEOUT_MS = 15_000;
const LOGIN_SESSION_TTL_MS = 10 * 60 * 1_000;
const LOGIN_COMPLETE_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 25_000;
const SIGNED_OUT_MARKER = "Authentication required";
const BROWSER_OPENERS = ["open", "xdg-open", "x-www-browser", "www-browser"] as const;

const ENV_KEYS = new Set([
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "TZ",
  "TMPDIR",
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
const ENV_PREFIXES = ["LC_", "AGY_", "GEMINI_", "GOOGLE_"] as const;

const bucketSchema = z.object({
  name: z.string(),
  window: z.string().optional(),
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

export interface AntigravityProfilePaths {
  profileHomeDir: string;
  geminiDir: string;
  appDataDir: string;
}

export function resolveAntigravityProfilePaths(
  profileId: string,
  baseDir?: string,
): AntigravityProfilePaths {
  if (!UUID_PATTERN.test(profileId)) {
    throw new Error(`Invalid Antigravity profile id "${profileId}".`);
  }
  const root = baseDir ?? join(homedir(), ...PROFILES_SUBPATH);
  const profileHomeDir = join(root, profileId);
  return {
    profileHomeDir,
    geminiDir: join(profileHomeDir, ".gemini"),
    appDataDir: APP_DATA_DIR,
  };
}

export function resolveAgyCommand(command?: string, env: NodeJS.ProcessEnv = process.env): string {
  const configured = command?.trim();
  if (configured) return configured;
  const fromEnv = env.BB_ANTIGRAVITY_EXECUTABLE?.trim();
  return fromEnv || "agy";
}

/**
 * Builds an isolated environment for `agy` where D-Bus keyring is omitted so
 * `agy` stores OAuth tokens in file-based storage inside the profile directory.
 */
export function buildIsolatedAgyEnv(args: {
  homeDir: string;
  pathValue: string | undefined;
  sourceEnv?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const sourceEnv = args.sourceEnv ?? process.env;
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
    HOME: args.homeDir,
    ...(args.pathValue === undefined ? {} : { PATH: args.pathValue }),
    AGY_CLI_DISABLE_AUTO_UPDATE: "true",
  };
}

function normalizeResetTime(value: string | undefined): number | null {
  if (value === undefined) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? Math.round(timestamp) : null;
}

function isGeminiGroupName(name: string): boolean {
  return /\bgemini\b/iu.test(name);
}

function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, Math.round(value * 10_000) / 10_000));
}

function isUnsafeUsageEnvelope(record: Record<string, unknown>): boolean {
  if ((record["num_turns"] ?? 0) !== 0 || (record["conversation_id"] ?? "") !== "") {
    return true;
  }
  const command = record["command"];
  if (command === undefined || command === null) {
    return record["status"] === "SUCCESS";
  }
  return typeof command !== "object" || (command as { name?: unknown }).name !== "usage";
}

function toGeminiUsageWindow(bucket: z.infer<typeof bucketSchema>): AntigravityUsageWindow | null {
  if (bucket.window !== "5h" && bucket.window !== "weekly") return null;
  const isPrimary = bucket.window === "5h";
  return {
    slot: isPrimary ? "primary" : "secondary",
    windowMinutes: isPrimary ? 300 : 10_080,
    utilization: clampFraction(1 - (bucket.remaining_fraction ?? 0)),
    resetAt: normalizeResetTime(bucket.reset_time),
  };
}

/**
 * Parses `agy -p /usage --output-format json` and keeps ONLY the Gemini group's
 * 5-hour (`primary`) and weekly (`secondary`) buckets.
 */
export function parseGeminiUsagePayload(
  body: unknown,
): { kind: "ok"; windows: AntigravityUsageWindow[] } | { kind: "unsafe" } | { kind: "failed" } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { kind: "failed" };
  }
  if (isUnsafeUsageEnvelope(body as Record<string, unknown>)) {
    return { kind: "unsafe" };
  }
  const parsed = usagePayloadSchema.safeParse(body);
  if (!parsed.success) return { kind: "failed" };

  const windows: AntigravityUsageWindow[] = [];
  for (const group of parsed.data.command.data.groups ?? []) {
    if (!isGeminiGroupName(group.name)) continue;
    for (const bucket of group.buckets ?? []) {
      const window = toGeminiUsageWindow(bucket);
      if (window !== null) windows.push(window);
    }
  }
  windows.sort((a, b) => a.windowMinutes - b.windowMinutes);
  return { kind: "ok", windows };
}

async function withNoBrowserPath<T>(
  run: (cwd: string, pathValue: string | undefined) => Promise<T>,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  if (process.platform === "win32") {
    return run(tmpdir(), sourceEnv.PATH);
  }
  const dir = await mkdtemp(join(tmpdir(), "bb-agy-pool-probe-"));
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

interface ActiveLoginSession {
  sessionId: string;
  profileId: string;
  command: string;
  paths: AntigravityProfilePaths;
  child: ChildProcess;
  tempBinDir: string | null;
  stderr: string;
  stdout: string;
  exited: boolean;
  exitCode: number | null;
  ttlTimer: ReturnType<typeof setTimeout>;
  onExitWaiters: Array<(result: { code: number | null; stdout: string; stderr: string }) => void>;
}

export interface AntigravityHostRuntimeOptions {
  baseDir?: string;
  spawnProcess?: typeof spawn;
  now?: () => number;
  loginStartTimeoutMs?: number;
  loginCompleteTimeoutMs?: number;
  probeTimeoutMs?: number;
}

export class AntigravityHostRuntime {
  private readonly sessions = new Map<string, ActiveLoginSession>();
  private readonly spawnProcess: typeof spawn;
  private readonly baseDir: string | undefined;
  private readonly loginStartTimeoutMs: number;
  private readonly loginCompleteTimeoutMs: number;
  private readonly probeTimeoutMs: number;

  constructor(options: AntigravityHostRuntimeOptions = {}) {
    this.baseDir = options.baseDir;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.loginStartTimeoutMs = options.loginStartTimeoutMs ?? LOGIN_START_TIMEOUT_MS;
    this.loginCompleteTimeoutMs = options.loginCompleteTimeoutMs ?? LOGIN_COMPLETE_TIMEOUT_MS;
    this.probeTimeoutMs = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  }

  private async cleanupSession(session: ActiveLoginSession): Promise<void> {
    clearTimeout(session.ttlTimer);
    this.sessions.delete(session.sessionId);
    if (!session.exited) {
      try {
        session.child.kill("SIGTERM");
      } catch {
        // Process already exited.
      }
    }
    if (session.tempBinDir !== null) {
      await rm(session.tempBinDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async loginStart(input: { profileId: string; command?: string }): Promise<{
    sessionId: string;
    authorizeUrl: string;
    profileHomeDir: string;
    geminiDir: string;
    appDataDir: string;
  }> {
    const paths = resolveAntigravityProfilePaths(input.profileId, this.baseDir);
    await mkdir(join(paths.geminiDir, paths.appDataDir), {
      recursive: true,
      mode: 0o700,
    });
    const command = resolveAgyCommand(input.command);

    let tempBinDir: string | null = null;
    let pathValue = process.env.PATH;
    if (process.platform !== "win32") {
      tempBinDir = await mkdtemp(join(tmpdir(), "bb-agy-pool-login-"));
      await Promise.all(
        BROWSER_OPENERS.map((name) =>
          writeFile(join(tempBinDir!, name), "#!/bin/sh\nexit 0\n", { mode: 0o700 }),
        ),
      );
      pathValue = [tempBinDir, process.env.PATH].filter(Boolean).join(delimiter);
    }

    const env = buildIsolatedAgyEnv({
      homeDir: paths.profileHomeDir,
      pathValue,
    });
    const child = this.spawnProcess(
      command,
      ["acp", "--gemini-dir", paths.geminiDir, "--app-data-dir", paths.appDataDir, "--login"],
      {
        cwd: paths.profileHomeDir,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    const sessionId = randomUUID();
    const session: ActiveLoginSession = {
      sessionId,
      profileId: input.profileId,
      command,
      paths,
      child,
      tempBinDir,
      stderr: "",
      stdout: "",
      exited: false,
      exitCode: null,
      ttlTimer: setTimeout(() => {
        void this.cleanupSession(session);
      }, LOGIN_SESSION_TTL_MS),
      onExitWaiters: [],
    };
    session.ttlTimer.unref();

    const finishExit = (code: number | null) => {
      if (session.exited) return;
      session.exited = true;
      session.exitCode = code;
      for (const waiter of session.onExitWaiters.splice(0)) {
        waiter({ code, stdout: session.stdout, stderr: session.stderr });
      }
    };

    return new Promise((resolve, reject) => {
      let settled = false;
      const startTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        void this.cleanupSession(session);
        reject(
          new Error(
            `Timed out waiting for \`${command} acp --login\` to print the Google sign-in link.`,
          ),
        );
      }, this.loginStartTimeoutMs);

      const maybeResolveUrl = () => {
        if (settled) return;
        const match = AUTHORIZE_URL_PATTERN.exec(session.stdout);
        if (match === null) return;
        settled = true;
        clearTimeout(startTimer);
        this.sessions.set(sessionId, session);
        resolve({
          sessionId,
          authorizeUrl: match[0],
          profileHomeDir: paths.profileHomeDir,
          geminiDir: paths.geminiDir,
          appDataDir: paths.appDataDir,
        });
      };

      child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
        session.stdout = (session.stdout + chunk).slice(-32_768);
        maybeResolveUrl();
      });
      child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
        session.stderr = (session.stderr + chunk).slice(-8_192);
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        finishExit(null);
        if (settled) return;
        settled = true;
        clearTimeout(startTimer);
        void this.cleanupSession(session);
        const message =
          error.code === "ENOENT"
            ? `Antigravity CLI (\`${command}\`) is not installed on this host.`
            : error.message;
        reject(new Error(message));
      });
      child.on("close", (code) => {
        finishExit(code);
        if (settled) return;
        settled = true;
        clearTimeout(startTimer);
        void this.cleanupSession(session);
        const detail = (session.stderr || session.stdout).trim();
        reject(
          new Error(
            detail ||
              `\`${command} acp --login\` exited with code ${code ?? "unknown"} before printing a sign-in link.`,
          ),
        );
      });
    });
  }

  async loginComplete(input: { sessionId: string; pasted: string }): Promise<{
    profileHomeDir: string;
    geminiDir: string;
    appDataDir: string;
    usage: AntigravityUsageProbe;
  }> {
    const session = this.sessions.get(input.sessionId);
    if (session === undefined) {
      throw new Error("Antigravity login session was not found or expired. Start again.");
    }
    const trimmed = input.pasted.trim();
    if (trimmed.length === 0) {
      throw new Error("Paste the authorization code or callback URL.");
    }

    const exitPromise = session.exited
      ? Promise.resolve({
          code: session.exitCode,
          stdout: session.stdout,
          stderr: session.stderr,
        })
      : new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
          const timer = setTimeout(() => {
            void this.cleanupSession(session);
            reject(new Error("Timed out waiting for Antigravity sign-in to complete."));
          }, this.loginCompleteTimeoutMs);
          session.onExitWaiters.push((result) => {
            clearTimeout(timer);
            resolve(result);
          });
        });

    session.child.stdin?.write(`${trimmed}\n`);
    session.child.stdin?.end();

    const result = await exitPromise;
    await this.cleanupSession(session);
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim();
      throw new Error(detail || `Antigravity login failed (exit ${result.code ?? "unknown"}).`);
    }

    const usage = await this.probeUsage({
      profileId: session.profileId,
      command: session.command,
    });
    return {
      profileHomeDir: session.paths.profileHomeDir,
      geminiDir: session.paths.geminiDir,
      appDataDir: session.paths.appDataDir,
      usage,
    };
  }

  async loginCancel(input: { sessionId: string }): Promise<{ cancelled: boolean }> {
    const session = this.sessions.get(input.sessionId);
    if (session === undefined) return { cancelled: false };
    await this.cleanupSession(session);
    return { cancelled: true };
  }

  async probeUsage(input: { profileId: string; command?: string }): Promise<AntigravityUsageProbe> {
    const paths = resolveAntigravityProfilePaths(input.profileId, this.baseDir);
    try {
      await stat(paths.profileHomeDir);
    } catch {
      return {
        status: "unauthenticated",
        windows: [],
        message: "Antigravity profile has not been signed in on this host.",
      };
    }
    const command = resolveAgyCommand(input.command);

    return withNoBrowserPath(async (cwd, pathValue) => {
      const env = buildIsolatedAgyEnv({
        homeDir: paths.profileHomeDir,
        pathValue,
      });
      return new Promise<AntigravityUsageProbe>((resolve) => {
        const child = this.spawnProcess(
          command,
          ["-p", "/usage", "--output-format", "json", "--disable-slash-commands"],
          {
            cwd,
            env,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let stdout = "";
        let stderr = "";
        let settled = false;
        let signedOut = false;

        const settle = (probe: AntigravityUsageProbe) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(probe);
        };

        const timer = setTimeout(() => {
          try {
            child.kill("SIGTERM");
          } catch {
            // Already exited.
          }
          settle({
            status: "error",
            windows: [],
            message: `Timed out reading Gemini usage from \`${command} -p /usage\`.`,
          });
        }, this.probeTimeoutMs);

        child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
          if (stdout.length < 1_048_576) stdout += chunk;
        });
        child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
          stderr = (stderr + chunk).slice(-4_096);
          if (!signedOut && stderr.includes(SIGNED_OUT_MARKER)) {
            signedOut = true;
            try {
              child.kill("SIGTERM");
            } catch {
              // Already exited.
            }
          }
        });
        child.on("error", (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") {
            settle({
              status: "not_installed",
              windows: [],
              message: `Antigravity CLI (\`${command}\`) is not installed on this host.`,
            });
            return;
          }
          settle({
            status: "error",
            windows: [],
            message: error.message,
          });
        });
        child.on("close", (code) => {
          if (signedOut || stderr.includes(SIGNED_OUT_MARKER)) {
            settle({
              status: "unauthenticated",
              windows: [],
              message: "Sign in to Antigravity again on this host.",
            });
            return;
          }
          if (code !== 0) {
            settle({
              status: "error",
              windows: [],
              message:
                stderr.trim() ||
                stdout.trim() ||
                `\`${command} -p /usage\` exited with code ${code ?? "unknown"}.`,
            });
            return;
          }
          let parsedBody: unknown;
          try {
            parsedBody = JSON.parse(stdout);
          } catch {
            settle({
              status: "error",
              windows: [],
              message: "Antigravity `/usage` returned invalid JSON.",
            });
            return;
          }
          const result = parseGeminiUsagePayload(parsedBody);
          if (result.kind !== "ok") {
            settle({
              status: "error",
              windows: [],
              message: "Unexpected Antigravity `/usage` response.",
            });
            return;
          }
          if (result.windows.length === 0) {
            settle({
              status: "no_quota",
              windows: [],
              message: "No Gemini quota buckets were reported for this Antigravity account.",
            });
            return;
          }
          settle({
            status: "ok",
            windows: result.windows,
            message: null,
          });
        });
      });
    });
  }

  async removeProfile(input: { profileId: string }): Promise<{ removed: boolean }> {
    const paths = resolveAntigravityProfilePaths(input.profileId, this.baseDir);
    try {
      await stat(paths.profileHomeDir);
    } catch {
      return { removed: false };
    }
    await rm(paths.profileHomeDir, { recursive: true, force: true });
    return { removed: true };
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => this.cleanupSession(session)));
  }
}
