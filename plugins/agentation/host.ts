/**
 * Agentation's host entry: runs the shared `agentation-mcp server` on this
 * machine's localhost:4747 when the server entry asks it to. The CLI is the
 * one the stdio `agentation` MCP entry already needs, so the server keeps its
 * own SQLite store in ~/.agentation.
 */
import { spawn } from "node:child_process";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { closeSync, constants, openSync } from "node:fs";
import { connect } from "node:net";
import { delimiter, join } from "node:path";
import {
  experimental_defineHostEntry,
  experimental_readProcessIdentity,
  experimental_sanitizeInheritedChildProcessEnv,
} from "@get-bb/plugin-sdk/host";
import { agentationHostContract, LOCAL_SERVER_PORT } from "./lib/local-server-contract.ts";
import { createLocalServerSupervisor, type LocalServerDeps } from "./lib/local-server.ts";

const LOG_TAIL_BYTES = 1500;

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

async function findBinary(): Promise<string | null> {
  if (process.platform === "win32") return null;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "agentation-mcp");
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not in this directory.
    }
  }
  return null;
}

/** Paths are fixed by the first call; a worker serves one daemon data directory. */
let dataDir: string | null = null;
const logPath = () => join(dataDir ?? ".", "agentation-server.log");
const pidPath = () => join(dataDir ?? ".", "agentation-server.pid");

const deps: LocalServerDeps = {
  portBusy,
  findBinary,
  spawn(binary, args) {
    // The server writes straight to the log file, so it keeps running, and
    // logging, if this worker dies; the next worker adopts it by PID.
    const log = openSync(logPath(), "w");
    const child = spawn(binary, [...args], {
      stdio: ["ignore", log, log],
      env: experimental_sanitizeInheritedChildProcessEnv({ env: process.env }),
    });
    closeSync(log);
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
    return {
      pid: child.pid ?? -1,
      exited,
      kill: () => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      },
    };
  },
  async logTail() {
    try {
      const text = await readFile(logPath(), "utf8");
      return text.slice(-LOG_TAIL_BYTES).trim();
    } catch {
      return "";
    }
  },
  async readRecordedPid() {
    try {
      const pid = Number.parseInt(await readFile(pidPath(), "utf8"), 10);
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  },
  async recordPid(pid) {
    if (pid === null || pid < 0) await rm(pidPath(), { force: true });
    else await writeFile(pidPath(), String(pid));
  },
  async commandOf(pid) {
    return (await experimental_readProcessIdentity(pid))?.command ?? null;
  },
  killPid(pid) {
    try {
      process.kill(pid, "SIGTERM");
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

const supervisor = createLocalServerSupervisor(deps);

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
