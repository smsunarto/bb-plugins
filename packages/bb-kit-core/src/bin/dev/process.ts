import { spawn, spawnSync, type SpawnOptions, type SpawnSyncOptions } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { createConnection } from "node:net";
import type { ProcessIdentity } from "./model.ts";

export type CommandResult = {
  status: number;
  stdout: string;
  stderr: string;
};

export class ProcessTimeoutError extends Error {
  readonly command: string;
  readonly timeoutMs: number;

  constructor(command: string, timeoutMs: number) {
    super(`${command} exceeded its ${timeoutMs}ms timeout.`);
    this.name = "ProcessTimeoutError";
    this.command = command;
    this.timeoutMs = timeoutMs;
  }
}

export function runCommand(
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions = {},
): CommandResult {
  const result = spawnSync(command, [...args], {
    ...options,
    encoding: "utf8",
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  return {
    status: result.status ?? 1,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

export function requireExecutable(path: string): void {
  accessSync(path, constants.X_OK);
}

export function processIdentity(pid: number): ProcessIdentity | null {
  const result = runCommand("ps", ["-o", "lstart=", "-p", String(pid)]);
  if (result.status !== 0 || result.stdout.trim() === "") {
    return null;
  }
  return { pid, started: result.stdout.trim() };
}

export function processMatches(identity: ProcessIdentity): boolean {
  try {
    process.kill(identity.pid, 0);
  } catch {
    return false;
  }
  try {
    const current = processIdentity(identity.pid);
    return current?.started === identity.started;
  } catch {
    return true;
  }
}

export function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (value: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(300, () => finish(false));
  });
}

export function signalExitCode(signal: NodeJS.Signals): number {
  if (signal === "SIGINT") {
    return 130;
  }
  if (signal === "SIGTERM") {
    return 143;
  }
  if (signal === "SIGHUP") {
    return 129;
  }
  return 128;
}

export function spawnAndWait(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
  onSpawn: (identity: ProcessIdentity) => void,
  waitOptions: { timeoutMs?: number } = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], options);
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let identity: ProcessIdentity | null = null;
    const clear = (): void => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    };
    const finishError = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      clear();
      child.removeListener("exit", finishExit);
      if (identity === null) {
        reject(error);
        return;
      }
      void rejectAfterTermination(identity, error, reject);
    };
    const finishExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clear();
      resolve(signal === null ? (code ?? 1) : signalExitCode(signal));
    };
    child.once("error", finishError);
    child.once("exit", finishExit);
    const pid = child.pid;
    if (pid === undefined) {
      finishError(new Error(`Could not start ${command}`));
      return;
    }
    try {
      identity = processIdentity(pid);
    } catch (error) {
      child.kill();
      finishError(error);
      return;
    }
    if (identity === null) {
      child.kill();
      finishError(new Error(`Could not record process identity for ${command}`));
      return;
    }
    try {
      onSpawn(identity);
    } catch (error) {
      finishError(error);
      return;
    }
    if (waitOptions.timeoutMs !== undefined) {
      timeout = setTimeout(
        () => finishError(new ProcessTimeoutError(command, waitOptions.timeoutMs ?? 0)),
        Math.max(0, waitOptions.timeoutMs),
      );
    }
  });
}

async function rejectAfterTermination(
  identity: ProcessIdentity,
  error: unknown,
  reject: (reason?: unknown) => void,
): Promise<void> {
  try {
    await terminateOwnedProcessGroup(identity);
  } finally {
    reject(error);
  }
}

export async function terminateOwnedProcessGroup(identity: ProcessIdentity): Promise<void> {
  if (!processMatches(identity)) {
    return;
  }
  signalOwnedProcess(identity, "SIGTERM");
  await waitForProcessExit(identity, 250);
  if (processMatches(identity)) {
    signalOwnedProcess(identity, "SIGKILL");
    await waitForProcessExit(identity, 1_000);
  }
}

export function inheritProcess(command: string, args: readonly string[]): Promise<number> {
  return waitForChild(spawn(command, [...args], { stdio: "inherit" }));
}

export function waitForChild(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      resolve(signal === null ? (code ?? 1) : signalExitCode(signal)),
    );
  });
}

function signalOwnedProcess(identity: ProcessIdentity, signal: NodeJS.Signals): void {
  if (!processMatches(identity)) {
    return;
  }
  try {
    process.kill(process.platform === "win32" ? identity.pid : -identity.pid, signal);
  } catch (error) {
    if (!isMissingProcess(error)) {
      throw error;
    }
  }
}

async function waitForProcessExit(identity: ProcessIdentity, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (processMatches(identity) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function isMissingProcess(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ESRCH"
  );
}
