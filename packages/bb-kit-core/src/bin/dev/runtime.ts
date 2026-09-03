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
import { delimiter, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { DevError } from "./error.ts";
import type { LauncherTarget, ProcessIdentity } from "./model.ts";
import { processIdentity, processMatches, terminateOwnedProcessGroup } from "./process.ts";

/**
 * Extra runtimes on one owned checkout.
 *
 * An owned instance is a checkout: it clones bb, installs the dependencies,
 * builds the plugin SDK, and runs `scripts/bb-dev-app`. That is expensive and
 * there is no reason to repeat it per verification run.
 *
 * A runtime is the cheap half. It borrows an owned instance's checkout and
 * starts the dev stack itself, with its own instance id, data directory, and
 * port triple. It never installs, never builds, and never writes to the
 * checkout.
 *
 * That means bypassing `pnpm dev`. bb's `run-dev.ts` derives the instance id,
 * data directory, and ports from its own module path and then overwrites the
 * matching environment variables, so a second runtime driven through it would
 * always land on the first one's ports. Everything downstream of it reads the
 * environment instead: the app's Vite dev config takes BB_DEV_APP_PORT and
 * BB_SERVER_PORT, the server takes BB_SERVER_PORT and BB_DATA_DIR, and the host
 * daemon takes BB_HOST_DAEMON_PORT, BB_DATA_DIR, and BB_SERVER_URL. So bb-kit
 * sets that environment itself and runs the same Turbo command `run-dev.ts`
 * would have run.
 *
 * Bypassing bb's own launcher means bb-kit is now responsible for a contract it
 * does not own. `assertRuntimeEnvContract` fails loudly when the checkout's
 * `toDevProcessEnv` stops matching the key set mirrored here.
 */

const APP_PORT_BASE = 11_000;
const SERVER_PORT_BASE = 19_000;
const HOST_DAEMON_PORT_BASE = 27_000;
const CLOUD_PORT_BASE = 35_000;
const PORT_BUCKETS = 8_000;
const PROD_SERVER_PORT = 38_886;
const PROD_HOST_DAEMON_PORT = 38_887;
const MANAGED_WORKTREE_DIR_NAME = "worktrees";

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

export type RuntimePorts = {
  appPort: number;
  serverPort: number;
  hostDaemonPort: number;
  cloudPort: number;
};

export type RuntimeRecord = {
  identity: ProcessIdentity;
  ports: RuntimePorts;
};

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
 * to give each dev instance its own identity -- agent-proxy derives its port
 * and its launchd label from it, and refuses to load without one. A runtime is
 * a dev instance, so it carries the same shape. The hash is over the runtime
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

export function runtimeTarget(args: {
  name: string;
  checkoutPath: string;
  launcherName: string;
  homeDir: string;
  ports: RuntimePorts;
  running: boolean;
  /** Copied from the source instance: a runtime runs the same checkout. */
  toolchain: { branch: string | null; node: string | null; codex: string | null };
}): LauncherTarget {
  const instanceId = runtimeInstanceId(args.name);
  const dataDir = join(args.homeDir, ".bb-dev", instanceId);
  const logRoot = join(args.homeDir, ".bb-dev", "launchers", args.launcherName);
  return {
    repository: resolve(args.checkoutPath),
    branch: args.toolchain.branch,
    node: args.toolchain.node,
    codex: args.toolchain.codex,
    instanceId,
    dataDir,
    appUrl: `http://localhost:${args.ports.appPort}`,
    serverUrl: `http://127.0.0.1:${args.ports.serverPort}`,
    hostDaemonUrl: `http://127.0.0.1:${args.ports.hostDaemonPort}`,
    desktopUserDataDir: join(dataDir, "desktop"),
    devSession: args.running ? "running" : "stopped",
    // Desktop is deliberately out of scope for runtimes: the Electron shell
    // reads the checkout's build output, which a runtime does not own.
    desktopSession: "stopped",
    devLog: join(logRoot, "dev.log"),
    desktopLog: join(logRoot, "desktop.log"),
    launcherLog: join(logRoot, "launcher.log"),
    appPort: args.ports.appPort,
    serverPort: args.ports.serverPort,
    hostDaemonPort: args.ports.hostDaemonPort,
  };
}

/**
 * The environment `run-dev.ts` would have handed Turbo, for this runtime's
 * ports and data directory instead of the checkout path's.
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
 * A runtime does not run bb's launcher, so nothing else would notice a bb
 * release that adds a variable the dev stack needs. This reads the contract out
 * of the checkout's own source rather than trusting that it has not moved.
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
      "Use a bb revision that still defines toDevProcessEnv, or start this instance as its own checkout.",
    );
  }
  const body =
    /export function toDevProcessEnv\([\s\S]*?\n\s*return \{\n([\s\S]*?)\n\s*\};\n\}/.exec(text);
  if (body?.[1] === undefined) {
    throw new DevError(
      "unsupported_runtime_host",
      `Could not read toDevProcessEnv from ${source}.`,
      "Use a bb revision whose toDevProcessEnv returns an object literal, or start this instance as its own checkout.",
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
      "Update RUNTIME_ENV_KEYS and runtimeEnvironment in bb-kit, or start this instance as its own checkout.",
    );
  }
}

/**
 * Start the dev stack for a runtime and record the supervising process.
 *
 * Detached with its own process group, so stop can terminate the whole Turbo
 * tree the way the launcher's own stop does.
 */
export function startRuntimeProcess(args: {
  checkoutPath: string;
  target: LauncherTarget;
  ports: RuntimePorts;
  homeDir: string;
  base: NodeJS.ProcessEnv;
}): RuntimeRecord {
  const descriptor = openSync(args.target.devLog, "a");
  try {
    const child = spawn("pnpm", [...TURBO_ARGUMENTS], {
      cwd: args.checkoutPath,
      env: runtimeEnvironment(args),
      stdio: ["ignore", descriptor, descriptor],
      detached: true,
    });
    const pid = child.pid;
    if (pid === undefined) {
      throw new DevError(
        "runtime_start_failed",
        "Could not start the runtime dev stack.",
        "Inspect the dev log and retry start.",
        { logPath: args.target.devLog },
      );
    }
    const identity = processIdentity(pid);
    if (identity === null) {
      child.kill();
      throw new DevError(
        "process_identity_unavailable",
        "Could not record the runtime process identity.",
        "Retry from a normal local shell.",
      );
    }
    child.unref();
    return { identity, ports: args.ports };
  } finally {
    closeSync(descriptor);
  }
}

export async function stopRuntimeProcess(record: RuntimeRecord | null): Promise<void> {
  if (record === null) {
    return;
  }
  await terminateOwnedProcessGroup(record.identity);
}

export function runtimeIsRunning(record: RuntimeRecord | null): boolean {
  return record !== null && processMatches(record.identity);
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
  const identity = record["identity"];
  const ports = record["ports"];
  if (
    identity === null ||
    typeof identity !== "object" ||
    ports === null ||
    typeof ports !== "object"
  ) {
    return null;
  }
  const pid = (identity as Record<string, unknown>)["pid"];
  const started = (identity as Record<string, unknown>)["started"];
  if (typeof pid !== "number" || typeof started !== "string") {
    return null;
  }
  return {
    identity: { pid, started },
    ports: ports as RuntimePorts,
  };
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
