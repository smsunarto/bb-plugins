import { experimental_spawnHostProcess as spawnHostProcess } from "@get-bb/plugin-sdk/process";

export interface GroupProcessOptions {
  signal: AbortSignal;
  /** Stops the whole process group after this many milliseconds. */
  timeout: number;
  /** Added to the host's environment; the SDK resolves `PATH` from the host toolchain. */
  env?: Record<string, string>;
  /** Stdout beyond this many bytes stops the process and fails the call. */
  maxBuffer?: number;
  /** Time a stopped group gets to exit on SIGTERM before SIGKILL. */
  killGraceMs?: number;
}

const STDERR_TAIL_BYTES = 16 * 1024;

/**
 * Runs `command` as the leader of its own process group and resolves with its
 * trimmed stdout. On abort, timeout, or overflow it sends SIGTERM to the whole
 * group, then SIGKILL after `killGraceMs`, so helpers such as
 * `git-remote-https` and `ssh` stop with it instead of outliving the call.
 */
export function runGroupProcess(
  command: string,
  args: readonly string[],
  options: GroupProcessOptions,
): Promise<string> {
  const { signal, timeout, env = {}, maxBuffer = 1024 * 1024, killGraceMs = 5_000 } = options;
  const label = [command, ...args].join(" ");
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal));
      return;
    }
    // `detached` is setsid(2) on macOS and Linux: the child's pid becomes the group id.
    const child = spawnHostProcess(command, args, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = "";
    let stopReason: Error | null = null;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const killGroup = (killSignal: NodeJS.Signals): void => {
      // No pid means the spawn failed; `process.kill(-0)` would signal our own group.
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, killSignal);
      } catch {
        // Every process in the group has already exited.
      }
    };
    const stop = (reason: Error): void => {
      if (stopReason !== null || settled) return;
      stopReason = reason;
      killGroup("SIGTERM");
      killTimer = setTimeout(() => killGroup("SIGKILL"), killGraceMs);
    };
    const onAbort = (): void => stop(abortReason(signal));
    const timer = setTimeout(
      () => stop(new Error(`${label} timed out after ${timeout} ms`)),
      timeout,
    );
    signal.addEventListener("abort", onAbort, { once: true });

    const settle = (error: Error | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (stopReason !== null) {
        // The leader is gone; sweep any member that ignored SIGTERM or closed its pipes.
        killGroup("SIGKILL");
        clearTimeout(killTimer);
      }
      if (error !== null) {
        reject(error);
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8").trim());
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBuffer) {
        stop(new Error(`${label} wrote more than ${maxBuffer} bytes to stdout`));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
    });
    child.once("error", (error) => {
      stop(error);
      settle(error);
    });
    child.once("close", (code, exitSignal) => {
      if (stopReason !== null) return settle(stopReason);
      if (code === 0) return settle(null);
      const detail = stderr.trim();
      settle(
        new Error(
          `Command failed (${code === null ? `signal ${exitSignal}` : `exit ${code}`}): ${label}${
            detail.length > 0 ? `\n${detail}` : ""
          }`,
        ),
      );
    });
  });
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}
