import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { SUDO_OUTPUT_MAX_BYTES } from "../shared/schema.ts";

/**
 * Absolute on purpose: resolving `sudo` from PATH, or letting a caller or
 * setting choose the binary, would let a planted `sudo` read the password
 * from stdin. Tests inject a stub through `createSudoRunner` instead.
 */
export const SUDO_BINARY = "/usr/bin/sudo";

/** sudo resets the command's environment itself; this only keeps sudo's own messages predictable. */
const SUDO_ENV: NodeJS.ProcessEnv = {
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  LANG: "C",
  LC_ALL: "C",
};

/**
 * Run the command under coreutils `timeout` as root. Once sudo has
 * authenticated, the invoking user may not be allowed to signal it, so a
 * deadline enforced only from this side could leave a root command running.
 * Absent on macOS, where only the local kill below applies.
 */
export const TIMEOUT_BINARY = "/usr/bin/timeout";

const KILL_GRACE_MS = 5_000;
/** How long past the root-side deadline the local kill waits before acting. */
const LOCAL_DEADLINE_SLACK_MS = KILL_GRACE_MS + 5_000;
/** coreutils `timeout` exits 124 when the deadline ended the command. */
const TIMEOUT_EXIT = 124;

export interface SudoOutput {
  exitCode: number;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

export interface SudoRunner {
  /** `sudo -S -k -v`: true when sudo accepts the password. */
  validate(
    password: Buffer,
    signal: AbortSignal,
  ): Promise<{ ok: true } | { ok: false; detail: string }>;
  /** `sudo -S -k -- argv`, password on stdin, stdin then closed. */
  run(request: {
    argv: readonly string[];
    cwd: string;
    password: Buffer;
    timeoutMs: number;
    signal: AbortSignal;
  }): Promise<SudoOutput>;
}

class Capture {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  push(chunk: Buffer): void {
    const room = SUDO_OUTPUT_MAX_BYTES - this.size;
    if (room <= 0) {
      this.truncated = true;
      return;
    }
    const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
    if (kept.length < chunk.length) this.truncated = true;
    this.chunks.push(kept);
    this.size += kept.length;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

function spawnSudo(
  binary: string,
  args: readonly string[],
  options: {
    cwd?: string;
    password: Buffer;
    timeoutMs: number;
    signal: AbortSignal;
    /** The root-side wrapper owns the deadline; the local timer is a backstop. */
    rootDeadlineMs?: number;
  },
): Promise<SudoOutput> {
  return new Promise((resolve, reject) => {
    // `-p ''` keeps sudo from printing a prompt into the captured stderr.
    const child = spawn(binary, ["-S", "-k", "-p", "", ...args], {
      cwd: options.cwd,
      env: SUDO_ENV,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    const stdout = new Capture();
    const stderr = new Capture();
    const startedAt = Date.now();
    let spawned = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    // kill() can fail with EPERM once sudo runs as root; that must not
    // settle the call while the command is still running.
    const signalChild = (name: NodeJS.Signals) => {
      try {
        child.kill(name);
      } catch {
        // Reported through the child's 'error' event, ignored after spawn.
      }
    };
    const terminate = () => {
      signalChild("SIGTERM");
      killTimer ??= setTimeout(() => signalChild("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref();
    };
    const localDeadline =
      options.rootDeadlineMs === undefined
        ? options.timeoutMs
        : options.rootDeadlineMs + LOCAL_DEADLINE_SLACK_MS;
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, localDeadline);
    timer.unref();
    const onAbort = () => terminate();
    options.signal.addEventListener("abort", onAbort, { once: true });
    const settle = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal.removeEventListener("abort", onAbort);
    };

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("spawn", () => {
      spawned = true;
    });
    child.on("error", (error) => {
      if (spawned) return; // a failed kill(); 'close' still settles the call
      settle();
      reject(error);
    });
    child.on("close", (code, signal) => {
      settle();
      const rootTimedOut =
        options.rootDeadlineMs !== undefined &&
        code === TIMEOUT_EXIT &&
        Date.now() - startedAt >= options.rootDeadlineMs;
      resolve({
        exitCode: code ?? 128,
        signal: signal ?? null,
        stdout: stdout.text(),
        stderr: stderr.text(),
        truncated: stdout.truncated || stderr.truncated,
        timedOut: timedOut || rootTimedOut,
      });
    });
    // EPIPE when sudo exits before reading (NOPASSWD rule, bad argv) is harmless.
    child.stdin.on("error", () => {});
    const line = Buffer.concat([options.password, Buffer.from("\n")]);
    child.stdin.end(line, () => line.fill(0));
  });
}

export function createSudoRunner(
  options: { binary?: string; timeoutBinary?: string | null } = {},
): SudoRunner {
  const binary = options.binary ?? SUDO_BINARY;
  const timeoutBinary =
    options.timeoutBinary === undefined
      ? existsSync(TIMEOUT_BINARY)
        ? TIMEOUT_BINARY
        : null
      : options.timeoutBinary;
  return {
    async validate(password, signal) {
      const result = await spawnSudo(binary, ["-v"], { password, timeoutMs: 30_000, signal });
      if (result.exitCode === 0) return { ok: true };
      const detail = result.stderr.trim() || `sudo -v exited ${result.exitCode}`;
      return { ok: false, detail };
    },
    run({ argv, cwd, password, timeoutMs, signal }) {
      if (timeoutBinary === null) {
        return spawnSudo(binary, ["--", ...argv], { cwd, password, timeoutMs, signal });
      }
      const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
      const wrapped = [timeoutBinary, "-k", `${KILL_GRACE_MS / 1000}s`, `${seconds}s`, ...argv];
      return spawnSudo(binary, ["--", ...wrapped], {
        cwd,
        password,
        timeoutMs,
        signal,
        rootDeadlineMs: seconds * 1000,
      });
    },
  };
}
