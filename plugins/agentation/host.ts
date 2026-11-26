/**
 * Agentation's host entry: runs the shared `agentation-mcp server` on this
 * machine's localhost:4747 when the server entry asks it to. The CLI is the
 * one the stdio `agentation` MCP entry already needs, so the server keeps its
 * own SQLite store in ~/.agentation.
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { access, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { closeSync, constants, mkdirSync, openSync } from "node:fs";
import { connect } from "node:net";
import { delimiter, dirname, join } from "node:path";
import {
  experimental_defineHostEntry,
  experimental_readProcessIdentity,
  experimental_sanitizeInheritedChildProcessEnv,
} from "@get-bb/plugin-sdk/host";
import {
  experimental_hostToolchain as hostToolchain,
  experimental_spawnHostProcess as spawnHostProcess,
} from "@get-bb/plugin-sdk/process";
import { agentationHostContract, LOCAL_SERVER_PORT } from "./lib/local-server-contract.ts";
import { createLocalServerSupervisor, type LocalServerDeps } from "./lib/local-server.ts";

const LOG_TAIL_BYTES = 1500;
const BINARY = "agentation-mcp";

function portBusy(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port: LOCAL_SERVER_PORT });
    const done = (busy: boolean) => {
      socket.destroy();
      resolve(busy);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** The daemon's own PATH, searched directly; the fallback when bb's toolchain is unavailable. */
async function findOnPath(): Promise<string | null> {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, BINARY);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not in this directory.
    }
  }
  return null;
}

/**
 * bb's host toolchain also searches the login shell's PATH and version-manager
 * shims, where a GUI-launched daemon's PATH often lacks a global npm bin.
 */
export async function findBinary(): Promise<string | null> {
  if (process.platform === "win32") return null;
  try {
    const resolved = hostToolchain.resolve(BINARY);
    if (resolved) return resolved;
  } catch {
    // Fall through to the daemon's PATH.
  }
  return findOnPath();
}

/** Open the server's log for writing, creating the data directory first. */
export function openLogFile(path: string): number {
  mkdirSync(dirname(path), { recursive: true });
  return openSync(path, "w");
}

/** The last `maxBytes` of a file, read through one positioned read. */
export async function readLogTail(path: string, maxBytes: number): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, "r");
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    if (length <= 0) return "";
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, size - length);
    // The cut may split a multi-byte character; drop its undecodable start.
    return buffer
      .toString("utf8", 0, bytesRead)
      .replace(/^\uFFFD+/u, "")
      .trim();
  } catch {
    return "";
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Replace the PID file in one rename, so a reader never sees a partial write. */
export async function writePidFile(path: string, pid: number | null): Promise<void> {
  if (pid === null || pid < 0) {
    await rm(path, { force: true });
    return;
  }
  const temp = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    await writeFile(temp, String(pid));
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readPidFile(path: string): Promise<number | null> {
  try {
    const pid = Number.parseInt(await readFile(path, "utf8"), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function launch(binary: string, args: readonly string[], log: number): ChildProcess {
  const options = {
    stdio: ["ignore", log, log] as ["ignore", number, number],
    env: experimental_sanitizeInheritedChildProcessEnv({ env: process.env }),
  };
  try {
    return spawnHostProcess(binary, args, options);
  } catch {
    return nodeSpawn(binary, [...args], options);
  }
}

/** The supervisor's effects on this machine, rooted at `dataDir()`. */
export function createHostDeps(dataDir: () => string | null): LocalServerDeps {
  const logPath = () => join(dataDir() ?? ".", "agentation-server.log");
  const pidPath = () => join(dataDir() ?? ".", "agentation-server.pid");
  return {
    portBusy,
    findBinary,
    spawn(binary, args) {
      // The server writes straight to the log file, so it keeps running, and
      // logging, if this worker dies; the next worker adopts it by PID.
      const log = openLogFile(logPath());
      let child: ChildProcess;
      try {
        child = launch(binary, args, log);
      } finally {
        closeSync(log);
      }
      const exited = new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        child.once("exit", () => resolve());
        child.once("error", () => resolve());
      });
      return {
        pid: child.pid ?? -1,
        exited,
        kill: (signal = "SIGTERM") => {
          if (child.exitCode === null && child.signalCode === null) child.kill(signal);
        },
      };
    },
    logTail: () => readLogTail(logPath(), LOG_TAIL_BYTES),
    readRecordedPid: () => readPidFile(pidPath()),
    recordPid: (pid) => writePidFile(pidPath(), pid),
    async commandOf(pid) {
      return (await experimental_readProcessIdentity(pid))?.command ?? null;
    },
    killPid(pid, signal = "SIGTERM") {
      try {
        process.kill(pid, signal);
      } catch {
        // Already gone.
      }
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    setTimer(callback, ms) {
      const timer = setTimeout(callback, ms);
      timer.unref?.();
      return () => clearTimeout(timer);
    },
    log: (message) => console.error(`[agentation] ${message}`),
  };
}

/** Paths are fixed by the first call; a worker serves one daemon data directory. */
let dataDir: string | null = null;
const supervisor = createLocalServerSupervisor(createHostDeps(() => dataDir));

export default experimental_defineHostEntry({
  contract: agentationHostContract,
  handlers: {
    ensureLocalServer({ enabled }, context) {
      dataDir ??= context.experimental_paths.dataDir;
      return supervisor.ensure(enabled, () => context.experimental_retainWorker());
    },
  },
  dispose: () => supervisor.dispose(),
});
