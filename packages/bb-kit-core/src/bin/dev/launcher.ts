import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { DevError } from "./error.ts";
import type { DesiredRuntime, InstancePlan, LauncherTarget, ProcessIdentity } from "./model.ts";
import { ProcessTimeoutError, requireExecutable, runCommand, spawnAndWait } from "./process.ts";

export type LauncherOptions = {
  launcherPath: string;
  launcherName: string;
  checkoutPath: string;
  environment?: NodeJS.ProcessEnv;
};

const REQUIRED_STATUS_KEYS = [
  "Repo",
  "Instance",
  "Data dir",
  "App",
  "Server",
  "Host daemon",
  "Desktop user data",
  "Dev session",
  "Desktop session",
  "Logs",
] as const;

export function parseLauncherStatus(output: string): LauncherTarget {
  const values = new Map<string, string>();
  for (const line of output.split("\n")) {
    const separator = line.indexOf(": ");
    if (separator <= 0) {
      continue;
    }
    values.set(line.slice(0, separator), line.slice(separator + 2));
  }
  for (const key of REQUIRED_STATUS_KEYS) {
    if (!values.has(key)) {
      throw new DevError(
        "malformed_launcher_status",
        `Launcher status omitted "${key}".`,
        "Use a bb revision whose scripts/bb-dev-app supports current, stop, status, and env.",
      );
    }
  }
  const repository = required(values, "Repo");
  const dataDir = required(values, "Data dir");
  const appUrl = parseUrl(required(values, "App"), "App");
  const serverUrl = parseUrl(required(values, "Server"), "Server");
  const hostDaemonUrl = parseUrl(required(values, "Host daemon"), "Host daemon");
  const devSession = parseSession(required(values, "Dev session"), "Dev session");
  const desktopSession = parseSession(required(values, "Desktop session"), "Desktop session");
  const logs = required(values, "Logs").split(", ");
  if (logs.length !== 2 || logs[0] === undefined || logs[1] === undefined) {
    throw new DevError(
      "malformed_launcher_status",
      "Launcher status returned an invalid Logs value.",
      "Use a supported scripts/bb-dev-app revision.",
    );
  }
  return {
    repository: resolve(repository),
    instanceId: required(values, "Instance"),
    dataDir: resolve(dataDir),
    appUrl: appUrl.href.replace(/\/$/, ""),
    serverUrl: serverUrl.href.replace(/\/$/, ""),
    hostDaemonUrl: hostDaemonUrl.href.replace(/\/$/, ""),
    desktopUserDataDir: resolve(required(values, "Desktop user data")),
    devSession,
    desktopSession,
    devLog: resolve(logs[0]),
    desktopLog: resolve(logs[1]),
    launcherLog: join(dirname(resolve(logs[0])), "launcher.log"),
    appPort: requiredPort(appUrl, "App"),
    serverPort: requiredPort(serverUrl, "Server"),
    hostDaemonPort: requiredPort(hostDaemonUrl, "Host daemon"),
  };
}

export function assertLauncherSupported(options: LauncherOptions): void {
  try {
    requireExecutable(options.launcherPath);
  } catch {
    unsupported(options.launcherPath);
  }
  const result = runCommand(options.launcherPath, ["--help"], {
    cwd: options.checkoutPath,
    env: launcherEnvironment(options),
  });
  if (
    result.status !== 0 ||
    !["current", "stop", "status", "env"].every((command) => result.stdout.includes(command))
  ) {
    unsupported(options.launcherPath);
  }
}

export function readLauncherStatus(options: LauncherOptions): LauncherTarget {
  const result = runCommand(options.launcherPath, ["status"], {
    cwd: options.checkoutPath,
    env: launcherEnvironment(options),
  });
  if (result.status !== 0) {
    throw new DevError(
      "launcher_status_failed",
      `Launcher status failed for ${options.checkoutPath}.`,
      "Inspect the launcher log or use a supported bb revision.",
      { stderr: result.stderr.trim() },
    );
  }
  const target = parseLauncherStatus(result.stdout);
  if (target.repository !== resolve(options.checkoutPath)) {
    throw new DevError(
      "ambiguous_launcher_target",
      `Launcher reported repository ${target.repository}, not ${resolve(options.checkoutPath)}.`,
      "Do not stop or destroy this target. Inspect BB_DEV_REPO_ROOT and retry.",
    );
  }
  return target;
}

export async function runtimeSatisfied(
  target: LauncherTarget,
  desiredRuntime: DesiredRuntime,
  healthProbe: (url: string) => Promise<boolean> = probeApp,
): Promise<boolean> {
  if (target.devSession !== "running") {
    return false;
  }
  if (desiredRuntime === "desktop" && target.desktopSession !== "running") {
    return false;
  }
  return healthProbe(target.appUrl);
}

export function startLauncher(
  options: LauncherOptions,
  desiredRuntime: DesiredRuntime,
  launcherLog: string,
  onSpawn: (identity: ProcessIdentity) => void,
  timeoutMs: number,
): Promise<number> {
  return runLauncherCommand(
    options,
    desiredRuntime === "desktop" ? ["current", "--desktop"] : ["current"],
    launcherLog,
    onSpawn,
    timeoutMs,
  );
}

export function runLauncherCommand(
  options: LauncherOptions,
  args: readonly string[],
  launcherLog: string,
  onSpawn: (identity: ProcessIdentity) => void,
  timeoutMs: number,
): Promise<number> {
  const descriptor = openSync(launcherLog, "a");
  return spawnAndWait(
    options.launcherPath,
    args,
    {
      cwd: options.checkoutPath,
      env: launcherEnvironment(options),
      stdio: ["ignore", descriptor, descriptor],
      detached: true,
    },
    onSpawn,
    { timeoutMs },
  )
    .catch((error: unknown) => {
      if (error instanceof ProcessTimeoutError) {
        throw new DevError(
          "launcher_timeout",
          `Launcher command ${args[0] ?? "unknown"} exceeded its timeout.`,
          "Inspect the launcher log and retry the lifecycle command.",
          { logPath: launcherLog, timeoutMs },
        );
      }
      throw error;
    })
    .finally(() => closeSync(descriptor));
}

export async function probeApp(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_000);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "manual" });
    return response.status >= 200 && response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export function openApp(url: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.once("error", () => {});
  child.unref();
}

export function launcherOptions(
  plan: InstancePlan,
  environment: NodeJS.ProcessEnv,
): LauncherOptions {
  return {
    launcherPath: plan.launcherPath,
    launcherName: plan.launcherName,
    checkoutPath: plan.checkoutPath,
    environment,
  };
}

export function assertSameStoredTarget(stored: LauncherTarget, live: LauncherTarget): void {
  if (!sameTarget(stored, live)) {
    throw new DevError(
      "ambiguous_launcher_target",
      "Launcher status no longer matches the recorded target.",
      "Do not stop or destroy this instance. Inspect the checkout and state.json.",
    );
  }
}

export function leaseKeyFor(target: LauncherTarget): string {
  return `${target.appPort}-${target.serverPort}-${target.hostDaemonPort}`;
}

export function logPath(target: LauncherTarget, kind: "dev" | "desktop" | "launcher"): string {
  if (kind === "dev") {
    return target.devLog;
  }
  if (kind === "desktop") {
    return target.desktopLog;
  }
  return target.launcherLog;
}

export function writeShim(
  plan: InstancePlan & { target: LauncherTarget; leaseKey: string },
  binDir: string,
): void {
  mkdirSync(binDir, { recursive: true });
  const content = shimSource(plan.checkoutPath);
  const temporary = `${plan.shimPath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, content, { mode: 0o755 });
  renameSync(temporary, plan.shimPath);
  chmodSync(plan.shimPath, 0o755);
}

export function sameTarget(left: LauncherTarget, right: LauncherTarget): boolean {
  return (
    left.repository === right.repository &&
    left.instanceId === right.instanceId &&
    left.dataDir === right.dataDir &&
    left.appUrl === right.appUrl &&
    left.serverUrl === right.serverUrl &&
    left.hostDaemonUrl === right.hostDaemonUrl &&
    left.desktopUserDataDir === right.desktopUserDataDir &&
    left.devLog === right.devLog &&
    left.desktopLog === right.desktopLog &&
    left.launcherLog === right.launcherLog
  );
}

export function launcherEnvironment(options: LauncherOptions): NodeJS.ProcessEnv {
  const environment = { ...(options.environment ?? process.env) };
  for (const key of [
    "BB_SERVER_URL",
    "BB_CLI",
    "BB_THREAD_ID",
    "BB_ENVIRONMENT_ID",
    "BB_THREAD_STORAGE",
    "BB_PROJECT_ID",
  ]) {
    delete environment[key];
  }
  environment["BB_DEV_LAUNCHER_NAME"] = options.launcherName;
  environment["BB_DEV_REPO_ROOT"] = options.checkoutPath;
  return environment;
}

function required(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key);
  if (value === undefined || value === "") {
    throw new DevError(
      "malformed_launcher_status",
      `Launcher status returned an empty "${key}" value.`,
      "Use a supported scripts/bb-dev-app revision.",
    );
  }
  return value;
}

function shimSource(checkoutPath: string): string {
  return `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const checkout = ${JSON.stringify(checkoutPath)};
const caller = process.cwd();
const args = process.argv.slice(2);
if (
  args[0] === "plugin" &&
  ["build", "dev", "migrate", "types"].includes(args[1] ?? "")
) {
  if (args.length < 3 || args[2]?.startsWith("-")) {
    args.splice(2, 0, caller);
  } else if (args[2] === "." || args[2]?.startsWith("./") || args[2]?.startsWith("../")) {
    args[2] = resolve(caller, args[2]);
  }
}
const environment = { ...process.env };
for (const key of [
  "BB_SERVER_URL",
  "BB_CLI",
  "BB_THREAD_ID",
  "BB_ENVIRONMENT_ID",
  "BB_THREAD_STORAGE",
  "BB_PROJECT_ID",
]) {
  delete environment[key];
}
const child = spawn("pnpm", ["-C", checkout, "--silent", "bb:dev", ...args], {
  cwd: caller,
  env: environment,
  stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal));
}
child.once("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode =
    signal === null
      ? (code ?? 1)
      : signal === "SIGINT"
        ? 130
        : signal === "SIGTERM"
          ? 143
          : signal === "SIGHUP"
            ? 129
            : 128;
});
`;
}

function parseUrl(value: string, key: string): URL {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
    return url;
  } catch {
    throw new DevError(
      "malformed_launcher_status",
      `Launcher status returned an invalid ${key} URL.`,
      "Use a supported scripts/bb-dev-app revision.",
    );
  }
}

function requiredPort(url: URL, key: string): number {
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new DevError(
      "malformed_launcher_status",
      `Launcher status returned an invalid ${key} port.`,
      "Use a supported scripts/bb-dev-app revision.",
    );
  }
  return port;
}

function parseSession(value: string, key: string): "running" | "stopped" {
  if (value !== "running" && value !== "stopped") {
    throw new DevError(
      "malformed_launcher_status",
      `Launcher status returned invalid ${key} state "${value}".`,
      "Use a supported scripts/bb-dev-app revision.",
    );
  }
  return value;
}

function unsupported(path: string): never {
  throw new DevError(
    "unsupported_launcher",
    `The bb revision at ${path} lacks the required dev launcher contract.`,
    "Choose a revision whose scripts/bb-dev-app supports current, stop, status, and env.",
  );
}
