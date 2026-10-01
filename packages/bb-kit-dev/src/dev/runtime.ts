import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { DevError } from "./error.ts";
import type { LauncherTarget, ProcessIdentity } from "./model.ts";
import {
  processIdentity,
  processMatches,
  ProcessTimeoutError,
  runCommand,
  spawnAndWait,
  terminateOwnedProcessGroup,
} from "./process.ts";
import { cleanBbEnvironment } from "./routing.ts";

/**
 * How bb-kit runs a bb dev stack.
 *
 * bb's own entry point is `pnpm dev`, which is `run-dev.ts`: it derives the
 * instance id, data directory, and ports from the checkout path, exports them
 * through `toDevProcessEnv`, and runs Turbo's `dev` task for the app, the
 * server, and the host daemon. It has no stop, no status, and no way to run a
 * second stack on one checkout, because it always overwrites the environment
 * with what the path says.
 *
 * So bb-kit does the same job itself. It computes the environment `run-dev.ts`
 * would have exported, spawns the same Turbo command detached in its own
 * process group, records that process, and later reads the sockets to know
 * whether the stack is up and kills the group to stop it. An owned or attached
 * checkout gets the path-derived config bb itself would use, so the checkout's
 * `bb:dev` CLI finds the stack without any routing. A runtime shares a
 * checkout and gets a config derived from its name instead.
 *
 * Bypassing `run-dev.ts` means bb-kit mirrors a contract it does not own.
 * `assertRuntimeEnvContract` fails loudly when the checkout's `toDevProcessEnv`
 * stops matching the key set mirrored here.
 */

const APP_PORT_BASE = 11_000;
const SERVER_PORT_BASE = 19_000;
const HOST_DAEMON_PORT_BASE = 27_000;
const CLOUD_PORT_BASE = 35_000;
const PORT_BUCKETS = 8_000;
const PROD_SERVER_PORT = 38_886;
const PROD_HOST_DAEMON_PORT = 38_887;
const MANAGED_WORKTREE_DIR_NAME = "worktrees";
const DEV_DATA_ROOT = ".bb-dev";
const LOG_ROOT = "launchers";

/**
 * Every key bb's `toDevProcessEnv` sets, mirrored here because the runtime does
 * not go through it. Kept sorted so the drift check reads as a set comparison.
 */
export const RUNTIME_ENV_KEYS = [
  "BB_DATA_DIR",
  "BB_DEV_APP_PORT",
  "BB_DEV_CONNECT_BASE_URL",
  "BB_HOST_DAEMON_PORT",
  "BB_INHERITED_SKILLS_ROOTS",
  "BB_SERVER_PORT",
  "BB_SERVER_URL",
  "NODE_ENV",
] as const;

/** The Turbo invocation `run-dev.ts` performs, minus the TTY-only interface. */
const TURBO_ARGUMENTS = [
  "exec",
  "turbo",
  "run",
  "dev",
  "--filter=@bb/app",
  "--filter=@bb/server",
  "--filter=@bb/host-daemon",
  "--ui",
  "stream",
  "--concurrency",
  "20",
  "--no-update-notifier",
] as const;

/** The Electron shell, which bb's desktop dev task builds and launches. */
const DESKTOP_ARGUMENTS = [
  "exec",
  "turbo",
  "run",
  "dev",
  "--filter=@bb/desktop",
  "--ui",
  "stream",
  "--no-update-notifier",
] as const;

export type RuntimePorts = {
  appPort: number;
  serverPort: number;
  hostDaemonPort: number;
  cloudPort: number;
};

export type RuntimeRecord = {
  identity: ProcessIdentity;
  ports: RuntimePorts;
  desktop: ProcessIdentity | null;
};

export type Toolchain = { branch: string | null; node: string | null; codex: string | null };

/** bb maps two dev ports away from the packaged app's fixed pair. Mirrored. */
function reservePackagedAppPorts(port: number): number {
  if (port === PROD_SERVER_PORT) {
    return 59_000;
  }
  if (port === PROD_HOST_DAEMON_PORT) {
    return 59_001;
  }
  return port;
}

export function runtimePorts(offset: number): RuntimePorts {
  const bucket = ((offset % PORT_BUCKETS) + PORT_BUCKETS) % PORT_BUCKETS;
  return {
    appPort: APP_PORT_BASE + bucket,
    serverPort: SERVER_PORT_BASE + bucket,
    hostDaemonPort: HOST_DAEMON_PORT_BASE + bucket,
    cloudPort: reservePackagedAppPorts(CLOUD_PORT_BASE + bucket),
  };
}

/** The port set behind a leased target; the cloud port shares its offset. */
export function portsFor(target: LauncherTarget): RuntimePorts {
  return {
    ...runtimePorts(target.appPort - APP_PORT_BASE),
    appPort: target.appPort,
    serverPort: target.serverPort,
    hostDaemonPort: target.hostDaemonPort,
  };
}

/**
 * Where a runtime's port search starts.
 *
 * Derived from the name rather than the checkout path, which is the whole point:
 * many runtimes share one path, so the path cannot tell them apart. The offset
 * is only a starting guess -- `prepare` probes and moves on when it is taken.
 */
export function runtimePortOffset(name: string): number {
  return Number.parseInt(createHash("sha256").update(name).digest("hex").slice(0, 8), 16);
}

/**
 * A runtime's instance id, and so its data directory name.
 *
 * The 12 hex characters on the end are not decoration. Every bb dev data
 * directory ends in a hash of its checkout path, and plugins read that suffix
 * to give each dev instance its own identity, such as a per-instance port or a
 * launchd label. A runtime is a dev instance, so it carries the same shape. The hash is over the runtime
 * name, because the checkout path is shared and cannot tell runtimes apart.
 */
export function runtimeInstanceId(name: string): string {
  const digest = createHash("sha256").update(`bb-kit-runtime:${name}`).digest("hex").slice(0, 12);
  return `bb-kit-runtime-${name}-${digest}`;
}

/** bb's own rule: a dev instance's inherited skills come from the prod data dir. */
function inheritedSkillsRoots(homeDir: string, checkoutPath: string): string[] {
  const roots = [join(homeDir, ".bb", "skills")];
  const segments = resolve(checkoutPath).split(/[\\/]+/u);
  const worktreesIndex = segments.lastIndexOf(MANAGED_WORKTREE_DIR_NAME);
  if (worktreesIndex <= 0) {
    return roots;
  }
  const parentDataDir = segments.slice(0, worktreesIndex).join("/");
  if (parentDataDir.length === 0) {
    return roots;
  }
  return [...new Set([join(parentDataDir, "skills"), ...roots])];
}

/** bb's `sanitizeInstanceLabel`, mirrored. */
function sanitizeInstanceLabel(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^[._-]+|[._-]+$/gu, "");
  return sanitized.length > 0 ? sanitized : "worktree";
}

/** bb's `resolveRepoRootLabel`, mirrored: home-relative when under home. */
function checkoutLabel(homeDir: string, checkoutPath: string): string {
  const homeRelative = relative(homeDir, checkoutPath);
  if (
    homeRelative.length > 0 &&
    !homeRelative.startsWith("../") &&
    !homeRelative.startsWith("..\\") &&
    homeRelative !== ".." &&
    !isAbsolute(homeRelative)
  ) {
    return homeRelative;
  }
  return checkoutPath;
}

/**
 * The target bb itself derives for a checkout.
 *
 * This is `resolveDevInstanceConfig` from bb's `packages/config`: the instance
 * id is the sanitized home-relative label plus a hash of the path, the ports
 * come from the same hash, and the data directory sits under `~/.bb-dev`. An
 * owned or attached instance uses exactly this so the checkout's own `bb:dev`
 * CLI, which derives the same config with no environment, reaches the stack
 * bb-kit started.
 */
export function checkoutTarget(args: {
  checkoutPath: string;
  homeDir: string;
  /** The log directory name; the checkout label when null. */
  logName: string | null;
  toolchain: Toolchain;
}): LauncherTarget {
  const checkoutPath = resolve(args.checkoutPath);
  const hash = createHash("sha256").update(checkoutPath).digest("hex");
  const label = sanitizeInstanceLabel(checkoutLabel(args.homeDir, checkoutPath));
  const instanceId = `${label}-${hash.slice(0, 12)}`;
  const ports = runtimePorts(Number.parseInt(hash.slice(0, 8), 16) % PORT_BUCKETS);
  return targetFor({
    checkoutPath,
    homeDir: args.homeDir,
    instanceId,
    logName: args.logName ?? label,
    ports,
    toolchain: args.toolchain,
  });
}

export function runtimeTarget(args: {
  name: string;
  checkoutPath: string;
  homeDir: string;
  ports: RuntimePorts;
  /** Copied from the source instance: a runtime runs the same checkout. */
  toolchain: Toolchain;
}): LauncherTarget {
  const instanceId = runtimeInstanceId(args.name);
  return targetFor({
    checkoutPath: resolve(args.checkoutPath),
    homeDir: args.homeDir,
    instanceId,
    logName: instanceId,
    ports: args.ports,
    toolchain: args.toolchain,
  });
}

function targetFor(args: {
  checkoutPath: string;
  homeDir: string;
  instanceId: string;
  logName: string;
  ports: RuntimePorts;
  toolchain: Toolchain;
}): LauncherTarget {
  const dataDir = join(args.homeDir, DEV_DATA_ROOT, args.instanceId);
  const logRoot = join(args.homeDir, DEV_DATA_ROOT, LOG_ROOT, args.logName);
  return {
    repository: args.checkoutPath,
    branch: args.toolchain.branch,
    node: args.toolchain.node,
    codex: args.toolchain.codex,
    instanceId: args.instanceId,
    dataDir,
    appUrl: `http://localhost:${args.ports.appPort}`,
    serverUrl: `http://127.0.0.1:${args.ports.serverPort}`,
    hostDaemonUrl: `http://127.0.0.1:${args.ports.hostDaemonPort}`,
    desktopUserDataDir: join(dataDir, "desktop"),
    devSession: "stopped",
    desktopSession: "stopped",
    devLog: join(logRoot, "dev.log"),
    desktopLog: join(logRoot, "desktop.log"),
    launcherLog: join(logRoot, "launcher.log"),
    appPort: args.ports.appPort,
    serverPort: args.ports.serverPort,
    hostDaemonPort: args.ports.hostDaemonPort,
  };
}

/** What a checkout runs on, for status output. Never fails a start. */
export function readToolchain(checkoutPath: string): Toolchain {
  const branch = runCommand("git", ["-C", checkoutPath, "rev-parse", "--abbrev-ref", "HEAD"]);
  const head = runCommand("git", ["-C", checkoutPath, "rev-parse", "--short", "HEAD"]);
  const node = runCommand("node", ["--version"], { cwd: checkoutPath });
  return {
    branch:
      branch.status !== 0
        ? null
        : branch.stdout.trim() === "HEAD"
          ? `detached (${head.stdout.trim()})`
          : branch.stdout.trim(),
    node: node.status === 0 ? node.stdout.trim() : null,
    codex: null,
  };
}

/**
 * The environment `run-dev.ts` would have handed Turbo, for this target's
 * ports and data directory.
 */
export function runtimeEnvironment(args: {
  target: LauncherTarget;
  ports: RuntimePorts;
  homeDir: string;
  base: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const environment = { ...args.base };
  for (const key of [
    "BB_CLI",
    "BB_THREAD_ID",
    "BB_ENVIRONMENT_ID",
    "BB_THREAD_STORAGE",
    "BB_PROJECT_ID",
  ]) {
    delete environment[key];
  }
  return {
    ...environment,
    BB_DATA_DIR: args.target.dataDir,
    BB_DEV_APP_PORT: String(args.ports.appPort),
    BB_DEV_CONNECT_BASE_URL: `http://bb.localhost:${args.ports.cloudPort}`,
    BB_HOST_DAEMON_PORT: String(args.ports.hostDaemonPort),
    BB_INHERITED_SKILLS_ROOTS: inheritedSkillsRoots(args.homeDir, args.target.repository).join(
      delimiter,
    ),
    BB_SERVER_PORT: String(args.ports.serverPort),
    BB_SERVER_URL: args.target.serverUrl,
    NODE_ENV: "development",
  };
}

/**
 * Fail when the checkout's `toDevProcessEnv` no longer sets the keys mirrored
 * here.
 *
 * bb-kit does not run `run-dev.ts`, so nothing else would notice a bb release
 * that adds a variable the dev stack needs. This reads the contract out of the
 * checkout's own source rather than trusting that it has not moved.
 */
export function assertRuntimeEnvContract(checkoutPath: string): void {
  const source = join(checkoutPath, "packages", "config", "src", "runtime.ts");
  let text: string;
  try {
    text = readFileSync(source, "utf8");
  } catch {
    throw new DevError(
      "unsupported_runtime_host",
      `Checkout ${checkoutPath} has no packages/config/src/runtime.ts to check.`,
      "Use a bb revision that still defines toDevProcessEnv.",
    );
  }
  const body =
    /export function toDevProcessEnv\([\s\S]*?\n\s*return \{\n([\s\S]*?)\n\s*\};\n\}/.exec(text);
  if (body?.[1] === undefined) {
    throw new DevError(
      "unsupported_runtime_host",
      `Could not read toDevProcessEnv from ${source}.`,
      "Use a bb revision whose toDevProcessEnv returns an object literal.",
    );
  }
  const actual = new Set(
    [...body[1].matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*):/gmu)].map((match) => match[1] ?? ""),
  );
  const expected = new Set<string>(RUNTIME_ENV_KEYS);
  const missing = [...expected].filter((key) => !actual.has(key)).toSorted();
  const added = [...actual].filter((key) => !expected.has(key)).toSorted();
  if (missing.length > 0 || added.length > 0) {
    throw new DevError(
      "runtime_env_drift",
      `This bb revision's toDevProcessEnv no longer matches the runtime environment bb-kit sets.${
        missing.length > 0 ? ` Missing: ${missing.join(", ")}.` : ""
      }${added.length > 0 ? ` Unexpected: ${added.join(", ")}.` : ""}`,
      "Update RUNTIME_ENV_KEYS and runtimeEnvironment in bb-kit.",
    );
  }
}

export type DependencyInstallArgs = {
  checkoutPath: string;
  logPath: string;
  environment: NodeJS.ProcessEnv;
  onSpawn: (identity: ProcessIdentity) => void;
  deadline: number | null;
};

/**
 * What bb's removed launcher did before every start: install, rebuild native
 * modules, and build the plugin SDK the checkout's CLI serves plugins with.
 *
 * Every step is idempotent and fast once the checkout is warm. Each runs
 * detached in its own process group and is checkpointed through `onSpawn`, so
 * a start that times out or a manager that dies leaves nothing orphaned.
 */
export async function ensureDependencies(args: DependencyInstallArgs): Promise<void> {
  const steps: readonly (readonly [string, readonly string[]])[] = [
    ["pnpm", ["install", "--frozen-lockfile"]],
    ...(existsSync(join(args.checkoutPath, "scripts", "ensure-native-modules.mjs"))
      ? [["node", ["scripts/ensure-native-modules.mjs"]] as const]
      : []),
    [
      "pnpm",
      ["exec", "turbo", "run", "build", "--filter=@get-bb/plugin-sdk", "--no-update-notifier"],
    ],
  ];
  for (const [command, commandArgs] of steps) {
    await runLoggedStep({ ...args, command, args: commandArgs });
  }
}

/** One detached, logged, checkpointed, deadline-bound command in a checkout. */
export async function runLoggedStep(
  args: DependencyInstallArgs & {
    command: string;
    args: readonly string[];
  },
): Promise<void> {
  const label = [args.command, ...args.args].join(" ");
  mkdirSync(resolve(args.logPath, ".."), { recursive: true });
  const descriptor = openSync(args.logPath, "a");
  writeFileSync(descriptor, `\n[bb-kit] ${new Date().toISOString()} ${label}\n`);
  const timeoutMs = args.deadline === null ? undefined : Math.max(0, args.deadline - Date.now());
  let exitCode: number;
  try {
    exitCode = await spawnAndWait(
      args.command,
      args.args,
      {
        cwd: args.checkoutPath,
        env: { ...cleanBbEnvironment(args.environment), NODE_ENV: "development" },
        stdio: ["ignore", descriptor, descriptor],
        detached: true,
      },
      args.onSpawn,
      { timeoutMs },
    );
  } catch (error) {
    if (error instanceof ProcessTimeoutError) {
      throw new DevError(
        "dependency_timeout",
        `${label} exceeded the start timeout.`,
        "Inspect the launcher log and retry start with a longer --timeout.",
        { logPath: args.logPath, timeoutMs },
      );
    }
    throw error;
  } finally {
    closeSync(descriptor);
  }
  if (exitCode !== 0) {
    throw new DevError(
      "dependency_install_failed",
      `${label} exited with status ${exitCode}.`,
      "Inspect the launcher log and retry start.",
      { logPath: args.logPath },
    );
  }
}

/**
 * Start the dev stack, and the desktop shell when asked, recording the
 * supervising processes.
 *
 * Detached with their own process groups, so stop can terminate the whole
 * Turbo tree.
 */
export function startRuntimeProcess(args: {
  checkoutPath: string;
  target: LauncherTarget;
  ports: RuntimePorts;
  homeDir: string;
  base: NodeJS.ProcessEnv;
  desktop: boolean;
}): RuntimeRecord {
  const environment = runtimeEnvironment(args);
  const identity = spawnLogged(
    "pnpm",
    TURBO_ARGUMENTS,
    args.checkoutPath,
    environment,
    args.target.devLog,
  );
  if (!args.desktop) {
    return { identity, ports: args.ports, desktop: null };
  }
  let desktop: ProcessIdentity;
  try {
    desktop = spawnLogged(
      "pnpm",
      DESKTOP_ARGUMENTS,
      args.checkoutPath,
      { ...environment, BB_DESKTOP_USER_DATA_DIR: args.target.desktopUserDataDir },
      args.target.desktopLog,
    );
  } catch (error) {
    void terminateOwnedProcessGroup(identity);
    throw error;
  }
  return { identity, ports: args.ports, desktop };
}

function spawnLogged(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  logPath: string,
): ProcessIdentity {
  const descriptor = openSync(logPath, "a");
  try {
    const child = spawn(command, [...args], {
      cwd,
      env,
      stdio: ["ignore", descriptor, descriptor],
      detached: true,
    });
    const pid = child.pid;
    if (pid === undefined) {
      throw new DevError(
        "runtime_start_failed",
        "Could not start the dev stack.",
        "Inspect the dev log and retry start.",
        { logPath },
      );
    }
    const identity = processIdentity(pid);
    if (identity === null) {
      child.kill();
      throw new DevError(
        "process_identity_unavailable",
        "Could not record the dev stack process identity.",
        "Retry from a normal local shell.",
      );
    }
    child.unref();
    return identity;
  } finally {
    closeSync(descriptor);
  }
}

export async function stopRuntimeProcess(record: RuntimeRecord | null): Promise<void> {
  if (record === null) {
    return;
  }
  if (record.desktop !== null) {
    await terminateOwnedProcessGroup(record.desktop);
  }
  await terminateOwnedProcessGroup(record.identity);
}

export function runtimeIsRunning(record: RuntimeRecord | null): boolean {
  return record !== null && processMatches(record.identity);
}

export function desktopIsRunning(record: RuntimeRecord | null): boolean {
  return record !== null && record.desktop !== null && processMatches(record.desktop);
}

export function runtimeRecordPath(instanceRoot: string): string {
  return join(instanceRoot, "runtime.json");
}

export function readRuntimeRecord(instanceRoot: string): RuntimeRecord | null {
  const path = runtimeRecordPath(instanceRoot);
  if (!existsSync(path)) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const identity = parseIdentity(record["identity"]);
  const ports = record["ports"];
  if (identity === null || ports === null || typeof ports !== "object") {
    return null;
  }
  return {
    identity,
    ports: ports as RuntimePorts,
    desktop: parseIdentity(record["desktop"]),
  };
}

function parseIdentity(value: unknown): ProcessIdentity | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  const pid = (value as Record<string, unknown>)["pid"];
  const started = (value as Record<string, unknown>)["started"];
  return typeof pid === "number" && typeof started === "string" ? { pid, started } : null;
}

export function writeRuntimeRecord(instanceRoot: string, record: RuntimeRecord): void {
  mkdirSync(instanceRoot, { recursive: true });
  writeFileSync(runtimeRecordPath(instanceRoot), `${JSON.stringify(record, null, 2)}\n`, {
    mode: 0o600,
  });
}

export function clearRuntimeRecord(instanceRoot: string): void {
  rmSync(runtimeRecordPath(instanceRoot), { force: true });
}
