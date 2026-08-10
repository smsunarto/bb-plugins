import { spawn, type ChildProcess } from "node:child_process";

export type CoreState =
  | "not-installed"
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "crashed";

export interface ExitInfo {
  code: number | null;
  signal: string | null;
  at: number;
}

export interface SupervisorSnapshot {
  state: CoreState;
  pid: number | null;
  crashCount: number;
  lastExit: ExitInfo | null;
}

export interface SupervisorOptions {
  binPath: string;
  configPath: string;
  isInstalled: () => boolean;
  /** Base URL to probe for liveness; any HTTP response counts as listening
      (management routes 404 unauthenticated, so they are useless here). */
  probeUrl: () => string;
  onChange?: (snapshot: SupervisorSnapshot) => void;
  spawnImpl?: typeof spawn;
  fetchImpl?: typeof fetch;
  probeTimeoutMs?: number;
  probeIntervalMs?: number;
  backoffInitialMs?: number;
  backoffMaxMs?: number;
  /** A run at least this long resets the crash backoff. */
  healthyResetMs?: number;
  killGraceMs?: number;
  logLimit?: number;
  /** Start through a child-local umask 077 shell wrapper. Disable only in
      tests that need to provoke a direct spawn error. */
  privateUmask?: boolean;
}

interface ChildOutcome {
  code: number | null;
  signal: string | null;
  error?: Error;
}

/** Wakes the supervisor loop out of its parked/backoff sleeps when desired
    state changes. Stale waiters are inert (guarded by their `done` flag). */
class Wake {
  private waiters: Array<() => void> = [];

  poke(): void {
    const waiters = this.waiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  wait(signal: AbortSignal, timeoutMs?: number): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = () => {
        // `done` makes this single-settle by construction: waiter, timeout,
        // and abort all funnel through here and the first one latches it.
        if (done) return;
        done = true;
        if (timer !== null) clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        // oxlint-disable-next-line promise/no-multiple-resolved
        resolve();
      };
      this.waiters.push(finish);
      if (timeoutMs !== undefined) timer = setTimeout(finish, timeoutMs);
      signal.addEventListener("abort", finish, { once: true });
    });
  }
}

function waitExit(child: ChildProcess): Promise<ChildOutcome> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: ChildOutcome) => {
      if (settled) return;
      settled = true;
      child.removeListener("close", onClose);
      child.removeListener("error", onError);
      resolve(outcome);
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => finish({ code, signal });
    const onError = (error: Error) => finish({ code: null, signal: null, error });
    child.once("close", onClose);
    child.once("error", onError);
  });
}

/** Supervises the CLIProxyAPI core as a child process. Desired state is
    in-memory: autostart is re-evaluated on each plugin load, and a manual stop
    stays stopped for the lifetime of the load. The run loop never throws — bb's
    own service restart is only a last-resort safety net. */
export class Supervisor {
  private readonly options: Required<
    Pick<
      SupervisorOptions,
      | "probeTimeoutMs"
      | "probeIntervalMs"
      | "backoffInitialMs"
      | "backoffMaxMs"
      | "healthyResetMs"
      | "killGraceMs"
      | "logLimit"
    >
  > &
    SupervisorOptions;

  private stateValue: CoreState = "stopped";
  private desiredRunning = false;
  private child: ChildProcess | null = null;
  private wake = new Wake();
  private backoffMs: number;
  private crashCount = 0;
  private lastExit: ExitInfo | null = null;
  private logRing: string[] = [];

  constructor(options: SupervisorOptions) {
    this.options = {
      probeTimeoutMs: 15_000,
      probeIntervalMs: 250,
      backoffInitialMs: 1_000,
      backoffMaxMs: 30_000,
      healthyResetMs: 30_000,
      killGraceMs: 5_000,
      logLimit: 200,
      ...options,
    };
    this.backoffMs = this.options.backoffInitialMs;
  }

  get state(): CoreState {
    return this.stateValue;
  }

  snapshot(): SupervisorSnapshot {
    return {
      state: this.stateValue,
      pid: this.child?.pid ?? null,
      crashCount: this.crashCount,
      lastExit: this.lastExit,
    };
  }

  logs(): string[] {
    return [...this.logRing];
  }

  start(): void {
    this.desiredRunning = true;
    this.backoffMs = this.options.backoffInitialMs;
    this.wake.poke();
  }

  async stop(): Promise<void> {
    this.desiredRunning = false;
    if (this.child) {
      this.setState("stopping");
      await this.killChild();
    }
    this.wake.poke();
  }

  async restart(): Promise<void> {
    await this.stop();
    this.start();
  }

  /** Notify the loop that installation state may have changed. */
  poke(): void {
    this.wake.poke();
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      if (!this.desiredRunning || !this.options.isInstalled()) {
        this.setState(this.options.isInstalled() ? "stopped" : "not-installed");
        await this.wake.wait(signal);
        continue;
      }

      this.setState("starting");
      const spawnImpl = this.options.spawnImpl ?? spawn;
      let child: ChildProcess;
      try {
        const coreArgs = ["--config", this.options.configPath];
        const [command, args] =
          this.options.privateUmask === false
            ? [this.options.binPath, coreArgs]
            : [
                "/bin/sh",
                ["-c", 'umask 077; exec "$@"', "agent-proxy-core", this.options.binPath, ...coreArgs],
              ];
        child = spawnImpl(command, args, {
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        this.appendLog(`[supervisor] spawn failed: ${String(error)}`);
        this.recordCrash({ code: null, signal: null });
        await this.wake.wait(signal, this.nextBackoff());
        continue;
      }
      this.child = child;
      this.pipeLogs(child);
      const startedAt = Date.now();
      const exited = waitExit(child);
      let resolveAborted: () => void = () => {};
      const aborted = new Promise<void>((resolve) => {
        resolveAborted = resolve;
      });
      const onAbort = () => resolveAborted();
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      const clearAbortListener = () => signal.removeEventListener("abort", onAbort);

      const startup = await Promise.race([
        this.probeUntilUp(signal, child).then((listening) => ({ kind: "probe" as const, listening })),
        exited.then((outcome) => ({ kind: "exit" as const, outcome })),
        aborted.then(() => ({ kind: "abort" as const })),
      ]);

      if (startup.kind === "abort") {
        clearAbortListener();
        await this.killChild();
        this.child = null;
        this.setState("stopped");
        return;
      }

      if (startup.kind === "exit") {
        clearAbortListener();
        this.child = null;
        if (!this.desiredRunning) {
          this.setState("stopped");
          continue;
        }
        if (startup.outcome.error) {
          this.appendLog(`[supervisor] spawn failed: ${startup.outcome.error.message}`);
        }
        this.recordCrash(startup.outcome);
        await this.wake.wait(signal, this.nextBackoff());
        continue;
      }

      if (!startup.listening) {
        clearAbortListener();
        this.appendLog("[supervisor] readiness probe timed out; terminating process");
        await this.killChild();
        const outcome = await exited;
        this.child = null;
        if (!this.desiredRunning) {
          this.setState("stopped");
          continue;
        }
        this.recordCrash(outcome);
        await this.wake.wait(signal, this.nextBackoff());
        continue;
      }

      if (this.desiredRunning && this.child === child) this.setState("running");

      const outcome = await Promise.race([
        exited.then((exit) => ({ kind: "exit" as const, exit })),
        aborted.then(() => ({ kind: "abort" as const })),
      ]);
      clearAbortListener();

      if (outcome.kind === "abort") {
        await this.killChild();
        this.child = null;
        this.setState("stopped");
        return;
      }

      this.child = null;
      const uptimeMs = Date.now() - startedAt;
      if (!this.desiredRunning) {
        this.setState("stopped");
        continue;
      }
      if (uptimeMs >= this.options.healthyResetMs) this.backoffMs = this.options.backoffInitialMs;
      this.recordCrash(outcome.exit);
      await this.wake.wait(signal, this.nextBackoff());
    }
    await this.killChild();
    this.child = null;
  }

  private recordCrash(exit: ChildOutcome): void {
    this.crashCount += 1;
    this.lastExit = { code: exit.code, signal: exit.signal, at: Date.now() };
    this.appendLog(
      `[supervisor] core exited unexpectedly (code ${exit.code ?? "null"}, signal ${exit.signal ?? "null"}); retrying in ${Math.round(this.backoffMs / 1000)}s`,
    );
    this.setState("crashed");
  }

  private nextBackoff(): number {
    const current = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.options.backoffMaxMs);
    return current;
  }

  private async probeUntilUp(signal: AbortSignal, child: ChildProcess): Promise<boolean> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const deadline = Date.now() + this.options.probeTimeoutMs;
    const childAlive = () => child.exitCode === null && child.signalCode === null;
    while (!signal.aborted && this.desiredRunning && childAlive() && Date.now() < deadline) {
      try {
        await fetchImpl(this.options.probeUrl(), { signal: AbortSignal.timeout(1_000) });
        return true;
      } catch {
        await this.wake.wait(signal, this.options.probeIntervalMs);
      }
    }
    return false;
  }

  private pipeLogs(child: ChildProcess): void {
    const append = (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.trim().length > 0) this.appendLog(line);
      }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
  }

  private appendLog(line: string): void {
    this.logRing.push(line);
    if (this.logRing.length > this.options.logLimit) {
      this.logRing.splice(0, this.logRing.length - this.options.logLimit);
    }
  }

  private async killChild(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = waitExit(child);
    child.kill("SIGTERM");
    const graceful = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), this.options.killGraceMs)),
    ]);
    if (!graceful) {
      child.kill("SIGKILL");
      await exited;
    }
  }

  private setState(state: CoreState): void {
    if (state === this.stateValue) return;
    this.stateValue = state;
    this.options.onChange?.(this.snapshot());
  }
}
