import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/** Runs one agent-browser command against the shared Sauce Live browser and returns its `--json` data. */
export interface BrowserRunner {
  run(args: readonly string[], timeoutMs?: number): Promise<Record<string, unknown>>;
  /** How many times a call has launched or relaunched the browser since the runner was made. */
  launches?(): number;
}

export class BrowserUnavailableError extends Error {
  override readonly name = "BrowserUnavailableError";
}

/** An agent-browser command ran and reported a failure, or timed out: the page did not do what was asked. */
export class BrowserCommandError extends Error {
  override readonly name = "BrowserCommandError";
  constructor(
    readonly command: string,
    readonly detail: string,
  ) {
    super(`agent-browser ${command} failed: ${detail}`);
  }
}

const SESSION = "sauce-live";
/**
 * The daemon runs in its own agent-browser namespace, so a command run by hand in
 * the default one (`agent-browser --session sauce-live ...`, `session list`) cannot
 * reach it. On 2026-11-15 such a command, meant as read-only, carried other launch
 * settings: agent-browser relaunched the shared browser, which closed another
 * thread's live session and left it running on Sauce with no page to end it from.
 */
export const NAMESPACE = "bb-sauce";
/**
 * Shuts the browser daemon down after this long without a command, so a bb restart
 * cannot orphan it forever. Idleness, not age: a wall-clock limit (systemd
 * RuntimeMaxSec) killed the browser in the middle of live sessions. Sauce ends a
 * session after a few idle minutes, so an hour without commands holds none.
 */
export const BROWSER_IDLE_TIMEOUT_MS = 60 * 60 * 1000;

export type SauceBrowserPaths = { profile: string; headedConfig: string };

/**
 * The profile the user signed in to Sauce Labs with (Google sign-in, keyring-encrypted
 * cookies). Only a headed launch can read those cookies, so every call carries the
 * same headed settings and the daemon never relaunches the browser with other ones.
 */
export function sauceBrowserPaths(): SauceBrowserPaths {
  const root = join(homedir(), ".agent-browser", "profiles");
  return {
    profile: process.env.SAUCE_LIVE_PROFILE ?? join(root, "sauce-live"),
    headedConfig: process.env.SAUCE_LIVE_HEADED_CONFIG ?? join(root, "sauce-live-headed.json"),
  };
}

export function browserEnv(paths: SauceBrowserPaths, base: NodeJS.ProcessEnv = process.env) {
  return {
    ...base,
    AGENT_BROWSER_PROFILE: paths.profile,
    AGENT_BROWSER_CONFIG: paths.headedConfig,
    AGENT_BROWSER_HEADED: "1",
    AGENT_BROWSER_NAMESPACE: NAMESPACE,
    AGENT_BROWSER_IDLE_TIMEOUT_MS: String(BROWSER_IDLE_TIMEOUT_MS),
  };
}

/**
 * The process to spawn for one agent-browser call. A transient user scope keeps a
 * browser this call launches alive across bb restarts; it carries no runtime limit.
 */
export function browserCommand(
  binary: string,
  args: readonly string[],
  useScope: boolean,
): [string, ...string[]] {
  const command: [string, ...string[]] = [binary, "--json", "--session", SESSION, ...args];
  return useScope
    ? ["systemd-run", "--user", "--scope", "--quiet", "--collect", ...command]
    : command;
}

export function createAgentBrowserRunner(paths = sauceBrowserPaths()): BrowserRunner {
  const env = browserEnv(paths);
  const useScope = process.platform === "linux" && existsSync("/usr/bin/systemd-run");
  let launches = 0;
  return {
    launches: () => launches,
    run(args, timeoutMs = 30_000) {
      if (!existsSync(paths.profile)) {
        return Promise.reject(
          new BrowserUnavailableError(
            `The Sauce Live browser profile ${paths.profile} is missing on the bb server machine. Sign in to Sauce Labs there with agent-browser --profile ${paths.profile} first.`,
          ),
        );
      }
      const binary = findOnPath("agent-browser");
      if (!binary) {
        return Promise.reject(
          new BrowserUnavailableError("agent-browser is not on the bb server's PATH."),
        );
      }
      const [file, ...argv] = browserCommand(binary, args, useScope);
      return new Promise((resolve, reject) => {
        execFile(
          file,
          argv,
          { env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
          (error, stdout, stderr) => {
            if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
              reject(
                new BrowserUnavailableError(`${file} is not installed on the bb server machine`),
              );
              return;
            }
            const parsed = parseReply(stdout);
            if (parsed?.success === true) {
              const data = (parsed.data ?? {}) as Record<string, unknown>;
              if (launchedBrowser(data)) launches += 1;
              resolve(data);
              return;
            }
            const detail = `${parsed?.error ?? (stderr || stdout || error?.message || "no output")}`;
            reject(new BrowserCommandError(args[0] ?? "", detail.trim().slice(0, 600)));
          },
        );
      });
    },
  };
}

/** agent-browser reports in `lifecycle` when a call started a browser that was not running. */
export function launchedBrowser(data: Record<string, unknown>): boolean {
  const lifecycle = data.lifecycle as
    | { launched?: unknown; relaunchedBrowser?: unknown }
    | undefined;
  return lifecycle?.launched === true || lifecycle?.relaunchedBrowser === true;
}

function findOnPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}

type BrowserReply = { success?: boolean; data?: unknown; error?: unknown };

/**
 * agent-browser prints one JSON object per command, and for `batch` one JSON array
 * with an entry per sub-command. A batch succeeds only when every entry did; its
 * data is the launch report of whichever entry started the browser, if any.
 */
export function parseReply(stdout: string): BrowserReply | null {
  const line = stdout
    .trim()
    .split("\n")
    .reverse()
    .find((candidate) => candidate.startsWith("{") || candidate.startsWith("["));
  if (!line) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return parsed as BrowserReply;
  const entries = parsed as {
    command?: string[];
    success?: boolean;
    error?: unknown;
    result?: unknown;
  }[];
  const failedAt = entries.findIndex((entry) => entry.success !== true);
  if (failedAt >= 0) {
    const failed = entries[failedAt];
    return {
      success: false,
      error: `step ${failedAt + 1} of ${entries.length} (${(failed?.command ?? []).join(" ")}): ${String(failed?.error ?? "failed")}`,
    };
  }
  const launched = entries
    .map((entry) => (entry.result ?? {}) as Record<string, unknown>)
    .find(launchedBrowser);
  return { success: true, data: launched ?? {} };
}

/** Serializes browser work: every tool drives the same tab, so two calls must never interleave. */
export function createQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = tail.then(work, work);
    tail = next.catch(() => undefined);
    return next;
  };
}
