import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/** Runs one agent-browser command against the shared Sauce Live browser and returns its `--json` data. */
export interface BrowserRunner {
  run(args: readonly string[], timeoutMs?: number): Promise<Record<string, unknown>>;
}

export class BrowserUnavailableError extends Error {
  override readonly name = "BrowserUnavailableError";
}

const SESSION = "sauce-live";
/** Bounds the browser daemon when this call launches it; a bb restart then cannot orphan it forever. */
const BROWSER_SCOPE_MAX_SECONDS = 4 * 60 * 60;

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

export function createAgentBrowserRunner(paths = sauceBrowserPaths()): BrowserRunner {
  const env = {
    ...process.env,
    AGENT_BROWSER_PROFILE: paths.profile,
    AGENT_BROWSER_CONFIG: paths.headedConfig,
    AGENT_BROWSER_HEADED: "1",
  };
  const useScope = process.platform === "linux" && existsSync("/usr/bin/systemd-run");
  return {
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
      const command = [binary, "--json", "--session", SESSION, ...args];
      // A transient user scope keeps a browser this call launches alive across bb restarts.
      const [file, ...argv] = useScope
        ? [
            "systemd-run",
            "--user",
            "--scope",
            "--quiet",
            "--collect",
            "-p",
            `RuntimeMaxSec=${BROWSER_SCOPE_MAX_SECONDS}`,
            ...command,
          ]
        : command;
      return new Promise((resolve, reject) => {
        execFile(
          file as string,
          argv,
          { env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
          (error, stdout, stderr) => {
            if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
              reject(
                new BrowserUnavailableError(`${file} is not installed on the bb server machine`),
              );
              return;
            }
            const parsed = parseJsonLine(stdout);
            if (parsed?.success === true) {
              resolve((parsed.data ?? {}) as Record<string, unknown>);
              return;
            }
            const detail = `${parsed?.error ?? (stderr || stdout || error?.message || "no output")}`;
            reject(new Error(`agent-browser ${args[0]} failed: ${detail.trim().slice(0, 600)}`));
          },
        );
      });
    },
  };
}

function findOnPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}

function parseJsonLine(
  stdout: string,
): { success?: boolean; data?: unknown; error?: unknown } | null {
  const line = stdout
    .trim()
    .split("\n")
    .reverse()
    .find((candidate) => candidate.startsWith("{"));
  if (!line) return null;
  try {
    return JSON.parse(line) as { success?: boolean; data?: unknown; error?: unknown };
  } catch {
    return null;
  }
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
