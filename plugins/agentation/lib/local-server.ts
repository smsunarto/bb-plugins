/**
 * Keeps one `agentation-mcp server` running on this machine for the browser
 * toolbars and the stdio `agentation` MCP entry that talk to localhost:4747.
 * The host entry owns one supervisor; every effect it has goes through
 * `LocalServerDeps`, so the policy is testable without a port or a process.
 *
 * Policy:
 * - Something already answering on the port is left alone ("external") and
 *   checked again every minute, so this machine takes over when it goes away.
 * - A server this plugin started survives a worker restart: its PID is
 *   recorded, and the next worker adopts it after confirming its command line.
 * - A crash restarts the server with a growing delay, at most five times in
 *   ten minutes; after that it stays down until the next ensure call.
 * - Stopping sends SIGTERM, waits up to two seconds, then sends SIGKILL and
 *   waits a further second at most, so a hung server cannot stall a stop.
 */
import { LOCAL_SERVER_PORT, type LocalServerState } from "./local-server-contract.ts";

export const LOCAL_SERVER_ARGS = [
  "server",
  "--port",
  String(LOCAL_SERVER_PORT),
  "--host",
  "127.0.0.1",
] as const;

const READY_TIMEOUT_MS = 10_000;
const READY_POLL_MS = 200;
const RECHECK_MS = 60_000;
const CRASH_WINDOW_MS = 10 * 60_000;
const MAX_CRASHES = 5;
const STOP_GRACE_MS = 2000;
const KILL_WAIT_MS = 1000;
const STOP_POLL_MS = 100;

export type LocalServerSignal = "SIGTERM" | "SIGKILL";

export interface LocalServerChild {
  readonly pid: number;
  /** Settles once when the process exits. */
  readonly exited: Promise<void>;
  /** Signal the process, SIGTERM by default; a no-op once it has exited. */
  kill(signal?: LocalServerSignal): void;
}

export interface LocalServerLease {
  dispose(): Promise<void>;
}

export interface LocalServerDeps {
  /** True when anything accepts a connection on 127.0.0.1:4747. */
  portBusy(): Promise<boolean>;
  /** The `agentation-mcp` executable on this daemon's PATH, or null. */
  findBinary(): Promise<string | null>;
  spawn(binary: string, args: readonly string[]): LocalServerChild;
  /** The last lines the server wrote, for a failure message. */
  logTail(): Promise<string>;
  readRecordedPid(): Promise<number | null>;
  recordPid(pid: number | null): Promise<void>;
  /** The command line of a live process, or null when it is gone. */
  commandOf(pid: number): Promise<string | null>;
  killPid(pid: number, signal?: LocalServerSignal): void;
  now(): number;
  sleep(ms: number): Promise<void>;
  setTimer(callback: () => void, ms: number): () => void;
  log(message: string): void;
}

const state = (
  value: LocalServerState["state"],
  pid: number | null = null,
  message: string | null = null,
): LocalServerState => ({ state: value, pid, message });

/** True for the command line of a server this plugin would start. */
export function isLocalServerCommand(command: string): boolean {
  return (
    command.includes("agentation-mcp") &&
    command.includes(" server") &&
    command.includes(`--port ${LOCAL_SERVER_PORT}`)
  );
}

export function createLocalServerSupervisor(deps: LocalServerDeps) {
  let enabled = false;
  let child: LocalServerChild | null = null;
  /** A server a previous worker started, which this worker can stop but not watch. */
  let adopted: number | null = null;
  let lease: LocalServerLease | null = null;
  let retain: (() => LocalServerLease) | null = null;
  let cancelRecheck: (() => void) | null = null;
  let crashes: number[] = [];
  let pending: Promise<LocalServerState> | null = null;
  let current: LocalServerState = state("stopped");

  const set = (next: LocalServerState) => (current = next);

  function hold() {
    if (!lease && retain) lease = retain();
  }

  function release() {
    const held = lease;
    lease = null;
    void held?.dispose();
  }

  function clearRecheck() {
    cancelRecheck?.();
    cancelRecheck = null;
  }

  /** Probe again later; take over the port once nothing answers on it. */
  function recheckLater() {
    clearRecheck();
    cancelRecheck = deps.setTimer(() => {
      cancelRecheck = null;
      if (enabled && !child) void run(start);
    }, RECHECK_MS);
  }

  function run(task: () => Promise<LocalServerState>): Promise<LocalServerState> {
    pending ??= task().finally(() => {
      pending = null;
    });
    return pending;
  }

  async function adoptRecorded(): Promise<number | null> {
    const pid = await deps.readRecordedPid();
    if (pid === null) return null;
    const command = await deps.commandOf(pid);
    if (command && isLocalServerCommand(command) && (await deps.portBusy())) return pid;
    await deps.recordPid(null);
    return null;
  }

  async function waitUntilReady(started: LocalServerChild): Promise<boolean> {
    let exited = false;
    void started.exited.finally(() => {
      exited = true;
    });
    const deadline = deps.now() + READY_TIMEOUT_MS;
    while (deps.now() < deadline) {
      if (exited) return false;
      if (await deps.portBusy()) return !exited;
      await deps.sleep(READY_POLL_MS);
    }
    return false;
  }

  function watch(started: LocalServerChild) {
    void started.exited.then(() => restartAfterExit(started));
  }

  async function restartAfterExit(started: LocalServerChild): Promise<void> {
    if (child !== started) return;
    child = null;
    await deps.recordPid(null);
    if (!enabled) return;
    const now = deps.now();
    crashes = [...crashes.filter((at) => now - at < CRASH_WINDOW_MS), now];
    if (crashes.length > MAX_CRASHES) {
      const tail = await deps.logTail();
      deps.log(`agentation server kept exiting; giving up until the next ensure call`);
      set(state("failed", null, `The server exited ${crashes.length} times. ${tail}`.trim()));
      release();
      return;
    }
    const delay = 2000 * crashes.length;
    deps.log(`agentation server exited; restarting in ${delay}ms`);
    clearRecheck();
    cancelRecheck = deps.setTimer(() => {
      cancelRecheck = null;
      if (enabled && !child) void run(start);
    }, delay);
  }

  /** Poll `gone` until it holds or `ms` pass; wakes early when `exited` settles. */
  async function waitUntilGone(
    gone: () => boolean | Promise<boolean>,
    ms: number,
    exited?: Promise<void>,
  ): Promise<boolean> {
    const deadline = deps.now() + ms;
    for (;;) {
      if (await gone()) return true;
      if (deps.now() >= deadline) return false;
      const pause = deps.sleep(STOP_POLL_MS);
      await (exited ? Promise.race([exited, pause]) : pause);
    }
  }

  /** SIGTERM, then SIGKILL after the grace period; never waits unboundedly. */
  async function terminateChild(running: LocalServerChild): Promise<void> {
    let exited = false;
    void running.exited.then(() => {
      exited = true;
    });
    running.kill("SIGTERM");
    if (await waitUntilGone(() => exited, STOP_GRACE_MS, running.exited)) return;
    deps.log(`agentation server (pid ${running.pid}) ignored SIGTERM; sending SIGKILL`);
    running.kill("SIGKILL");
    if (!(await waitUntilGone(() => exited, KILL_WAIT_MS, running.exited))) {
      deps.log(`agentation server (pid ${running.pid}) did not exit after SIGKILL`);
    }
  }

  /** The same escalation for a server an earlier worker started, watched by PID. */
  async function terminatePid(pid: number): Promise<void> {
    // A PID whose command is no longer the server has exited, even if reused.
    const gone = async () => {
      const command = await deps.commandOf(pid);
      return command === null || !isLocalServerCommand(command);
    };
    deps.killPid(pid, "SIGTERM");
    if (await waitUntilGone(gone, STOP_GRACE_MS)) return;
    deps.log(`agentation server (pid ${pid}) ignored SIGTERM; sending SIGKILL`);
    deps.killPid(pid, "SIGKILL");
    if (!(await waitUntilGone(gone, KILL_WAIT_MS))) {
      deps.log(`agentation server (pid ${pid}) did not exit after SIGKILL`);
    }
  }

  function terminate(running: LocalServerChild | null, pid: number | null): Promise<unknown> {
    return Promise.all([
      running ? terminateChild(running) : undefined,
      pid !== null ? terminatePid(pid) : undefined,
    ]);
  }

  async function start(): Promise<LocalServerState> {
    if (child) return set(state("running", child.pid));
    if (adopted !== null) {
      if ((await deps.commandOf(adopted)) && (await deps.portBusy())) {
        return set(state("running", adopted));
      }
      adopted = null;
      await deps.recordPid(null);
    }

    const recorded = await adoptRecorded();
    if (recorded !== null) {
      adopted = recorded;
      hold();
      recheckLater();
      return set(state("running", recorded, "adopted from an earlier worker"));
    }

    if (await deps.portBusy()) {
      hold();
      recheckLater();
      return set(state("external", null, `Another process answers on port ${LOCAL_SERVER_PORT}.`));
    }

    const binary = await deps.findBinary();
    if (!binary) {
      release();
      return set(
        state(
          "missing",
          null,
          "agentation-mcp is not on this machine's PATH. Install it to run the server.",
        ),
      );
    }

    hold();
    const started = deps.spawn(binary, LOCAL_SERVER_ARGS);
    child = started;
    await deps.recordPid(started.pid);
    if (await waitUntilReady(started)) {
      watch(started);
      deps.log(`agentation server running (pid ${started.pid})`);
      return set(state("running", started.pid));
    }

    // It exited or never listened. Another process may have taken the port first.
    child = null;
    started.kill();
    await deps.recordPid(null);
    if (await deps.portBusy()) {
      recheckLater();
      return set(state("external", null, `Another process answers on port ${LOCAL_SERVER_PORT}.`));
    }
    release();
    return set(state("failed", null, `The server did not start. ${await deps.logTail()}`.trim()));
  }

  async function stop(): Promise<LocalServerState> {
    // Let a start in flight finish, so its child is known and stopped here.
    await pending?.catch(() => undefined);
    clearRecheck();
    crashes = [];
    const running = child;
    const pid = adopted;
    child = null;
    adopted = null;
    await terminate(running, pid);
    await deps.recordPid(null);
    release();
    return set(state("stopped"));
  }

  return {
    /** Start, keep, or stop the server; repeated calls are cheap. */
    ensure(want: boolean, retainWorker: () => LocalServerLease): Promise<LocalServerState> {
      retain = retainWorker;
      enabled = want;
      if (!want) return stop();
      if (current.state === "failed" && !pending) crashes = [];
      return run(start);
    },
    current: () => current,
    /**
     * Stop a server this worker started. Called when the worker is disposed;
     * settles once the server exits, within the bounded stop escalation.
     */
    async dispose(): Promise<void> {
      enabled = false;
      clearRecheck();
      const running = child;
      const pid = adopted;
      child = null;
      adopted = null;
      const stopped = terminate(running, pid);
      void deps.recordPid(null);
      release();
      await stopped;
    },
  };
}
