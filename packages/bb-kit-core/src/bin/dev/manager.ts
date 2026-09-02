import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DevError, asDevError } from "./error.ts";
import {
  assertLauncherSupported,
  assertSameStoredTarget,
  launcherOptions,
  leaseKeyFor,
  logPath,
  openApp,
  probeApp,
  readLauncherStatus,
  runLauncherCommand,
  runtimeSatisfied,
  startLauncher,
  writeShim,
} from "./launcher.ts";
import {
  checkpoint,
  completePlan,
  devHome,
  emptyResult,
  existingRuntime,
  failedFromPlan,
  instancePaths,
  OFFICIAL_REPOSITORY,
  recoveringResolution,
  requireCompletePlan,
  requireTargetPlan,
  requestLabel,
  resultFromState,
  STATE_SCHEMA_VERSION,
  statePlan,
  type DesiredRuntime,
  type EnvironmentResult,
  type InstancePlan,
  type InstanceResult,
  type InstanceState,
  type LauncherTarget,
  type ResolvedRevision,
  type RevisionRequest,
} from "./model.ts";
import {
  inheritProcess,
  isPortListening,
  processIdentity,
  runCommand,
  waitForChild,
} from "./process.ts";
import { parseRevisionSelector, prepareCheckout, resolveRevision } from "./revision.ts";
import {
  assertLeaseOwned,
  claimLease,
  ensureOwnedDirectory,
  InstanceStore,
  releaseLease,
  safeRemoveOwned,
} from "./store.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_CHECKOUT_CANDIDATES = 16;

export type ManagerOptions = {
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  healthProbe?: (url: string) => Promise<boolean>;
  portProbe?: (port: number) => Promise<boolean>;
  progress?: (message: string) => void;
};

export type StartOptions = {
  name?: string;
  revision?: string;
  repository?: string;
  desktop?: boolean;
  open?: boolean;
  timeoutMs?: number;
};

export type { EnvironmentResult, InstanceResult } from "./model.ts";

export class DevManager {
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly home: string;
  private readonly healthProbe: (url: string) => Promise<boolean>;
  private readonly portProbe: (port: number) => Promise<boolean>;
  private readonly progress: (message: string) => void;

  constructor(options: ManagerOptions = {}) {
    this.cwd = resolve(options.cwd ?? process.cwd());
    this.environment = options.environment ?? process.env;
    this.home = devHome(this.environment);
    this.healthProbe = options.healthProbe ?? probeApp;
    this.portProbe = options.portProbe ?? isPortListening;
    this.progress = options.progress ?? (() => {});
  }

  resolveName(explicit?: string): string {
    if (explicit !== undefined) {
      if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(explicit)) {
        throw new DevError(
          "invalid_name",
          `Instance name "${explicit}" is invalid.`,
          "Use 1 to 63 lowercase letters, numbers, dots, underscores, or hyphens.",
        );
      }
      return explicit;
    }
    const environmentId = this.environment["BB_ENVIRONMENT_ID"];
    if (environmentId !== undefined && environmentId !== "") {
      const sanitized = sanitizeName(environmentId);
      if (sanitized !== "") {
        const hash = createHash("sha256").update(environmentId).digest("hex").slice(0, 10);
        return `environment-${sanitized.slice(0, 40)}-${hash}`;
      }
    }
    const gitRoot = runCommand("git", ["-C", this.cwd, "rev-parse", "--show-toplevel"]);
    if (gitRoot.status === 0 && gitRoot.stdout.trim() !== "") {
      return hashedName("workspace", realpathOrResolved(gitRoot.stdout.trim()));
    }
    return hashedName("directory", realpathOrResolved(this.cwd));
  }

  async start(options: StartOptions = {}): Promise<InstanceResult> {
    const name = this.resolveName(options.name);
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    const store = this.store(name);
    const owner = store.claim(name);
    const release = await store.lock(owner.ownerToken, remainingTimeout(deadline, name, "start"));
    try {
      let state = store.read();
      if (state !== null && state.ownerToken !== owner.ownerToken) {
        ownerMismatch(name);
      }
      if (state?.phase === "destroying") {
        throw new DevError(
          "instance_destroying",
          `Instance ${name} has an incomplete destroy operation.`,
          "Run bb-kit dev-instance destroy again before starting this name.",
        );
      }
      const desired = options.desktop === true ? "desktop" : (existingRuntime(state) ?? "web");
      const explicitRequest =
        options.revision === undefined ? undefined : parseRevisionSelector(options.revision);

      if (state === null) {
        state = this.createResolvingState(
          name,
          owner.ownerToken,
          explicitRequest ?? { kind: "latest" },
          desired,
          options.repository,
        );
        store.write(state);
      }

      let plan = statePlan(state);
      if (plan !== null && explicitRequest !== undefined) {
        this.progress(`Resolving ${options.revision} for ${name}`);
        const resolvedCommit =
          explicitRequest.kind === "commit"
            ? plan.revision.commit.startsWith(explicitRequest.commit)
              ? plan.revision.commit
              : explicitRequest.commit
            : (
                await this.resolveForState(
                  explicitRequest,
                  options.repository,
                  store.paths.root,
                  owner.ownerToken,
                )
              ).commit;
        if (resolvedCommit !== plan.revision.commit) {
          throw new DevError(
            "revision_mismatch",
            `Instance ${name} owns ${plan.revision.commit}, but ${options.revision} resolved to ${resolvedCommit}.`,
            "Choose another --name or destroy this stopped instance first.",
          );
        }
      }

      if (plan === null) {
        const resolving = recoveringResolution(state, desired);
        this.progress(`Resolving ${requestLabel(resolving.request)} for ${name}`);
        try {
          const revision = await this.resolveForState(
            resolving.request,
            options.repository ??
              (resolving.repository === OFFICIAL_REPOSITORY ? undefined : resolving.repository),
            store.paths.root,
            owner.ownerToken,
          );
          this.removeResolver(store.paths.root, owner.ownerToken);
          plan = this.newPlan(store, name, owner.ownerToken, revision, desired, 0);
          state = checkpoint(state, {
            phase: "preparing",
            step: "checkout",
            plan,
          });
          store.write(state);
        } catch (error) {
          const failure = asDevError(error);
          store.write(
            checkpoint(state, {
              phase: "failed",
              code: failure.code,
              message: failure.message,
              retryFrom: "resolution",
              resolving: {
                request: resolving.request,
                repository: resolving.repository,
                resolverPath: resolving.resolverPath,
                desiredRuntime: resolving.desiredRuntime,
              },
              plan: null,
            }),
          );
          throw failure;
        }
      }

      plan = { ...plan, desiredRuntime: desired };
      state = await this.prepare(store, state, plan, owner.ownerToken);
      const completePlan = requireCompletePlan(state);
      plan = completePlan;
      const launcher = launcherOptions(completePlan, this.environment);
      let live = readLauncherStatus(launcher);
      assertSameStoredTarget(completePlan.target, live);
      const livePlan = { ...completePlan, target: live, desiredRuntime: desired };
      plan = livePlan;

      if (await runtimeSatisfied(live, desired, this.healthProbe)) {
        state = checkpoint(state, {
          phase: "running",
          plan: livePlan,
          observedAt: new Date().toISOString(),
        });
        store.write(state);
        if (options.open === true) {
          openApp(live.appUrl);
        }
        return resultFromState(state, true);
      }

      if (store.activeExecs(owner.ownerToken).length > 0) {
        throw new DevError(
          "instance_busy",
          `Instance ${name} has an active bb command.`,
          "Wait for dev exec to finish, then retry start.",
        );
      }

      this.progress(`Starting ${name} at ${plan.revision.label}`);
      const startingPlan = requireTargetPlan(plan);
      const stateBeforeStart = state;
      let exitCode: number;
      try {
        exitCode = await startLauncher(
          launcher,
          desired,
          startingPlan.target.launcherLog,
          (child) => {
            state = checkpoint(stateBeforeStart, { phase: "starting", plan: startingPlan, child });
            store.write(state);
          },
          remainingTimeout(deadline, name, "start"),
        );
      } catch (error) {
        const failure = asDevError(error);
        store.write(failedFromPlan(state, startingPlan, failure, "start"));
        throw failure;
      }
      if (exitCode !== 0) {
        const failure = new DevError(
          "launcher_start_failed",
          `Launcher exited with status ${exitCode} for instance ${name}.`,
          "Inspect the launcher log and retry start.",
          { logPath: startingPlan.target.launcherLog },
        );
        store.write(failedFromPlan(state, startingPlan, failure, "start"));
        throw failure;
      }

      while (true) {
        live = readLauncherStatus(launcher);
        assertSameStoredTarget(startingPlan.target, live);
        if (await runtimeSatisfied(live, desired, this.healthProbe)) {
          break;
        }
        if (Date.now() >= deadline) {
          const failure = new DevError(
            "health_timeout",
            `Instance ${name} did not become healthy before the timeout.`,
            "Inspect the dev and launcher logs, then retry start.",
            { logPath: live.devLog },
          );
          store.write(failedFromPlan(state, { ...startingPlan, target: live }, failure, "start"));
          throw failure;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      }
      const runningPlan = { ...startingPlan, target: live };
      state = checkpoint(state, {
        phase: "running",
        plan: runningPlan,
        observedAt: new Date().toISOString(),
      });
      store.write(state);
      if (options.open === true) {
        openApp(live.appUrl);
      }
      return resultFromState(state, true);
    } finally {
      release();
    }
  }

  async status(nameOption?: string): Promise<InstanceResult> {
    const name = this.resolveName(nameOption);
    const store = this.store(name);
    if (!existsSync(store.paths.owner)) {
      return emptyResult(name);
    }
    const state = store.read();
    if (state === null) {
      return emptyResult(name);
    }
    const plan = statePlan(state);
    if (plan?.target === null || plan === null || !existsSync(plan.launcherPath)) {
      return resultFromState(state, false);
    }
    try {
      const live = readLauncherStatus(launcherOptions(plan, this.environment));
      assertSameStoredTarget(plan.target, live);
      const running = await runtimeSatisfied(live, plan.desiredRuntime, this.healthProbe);
      return { ...resultFromState(state, running), phase: running ? "running" : "stopped" };
    } catch {
      return resultFromState(state, false);
    }
  }

  async list(): Promise<readonly InstanceResult[]> {
    const root = join(this.home, "instances");
    if (!existsSync(root)) {
      return [];
    }
    const results: InstanceResult[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        results.push(await this.status(entry.name));
      }
    }
    return results.toSorted((left, right) => left.name.localeCompare(right.name));
  }

  async stop(nameOption?: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<InstanceResult> {
    const name = this.resolveName(nameOption);
    const deadline = Date.now() + timeoutMs;
    const store = this.store(name);
    if (!existsSync(store.paths.owner)) {
      return emptyResult(name);
    }
    const owner = store.readOwner();
    const release = await store.lock(owner.ownerToken, remainingTimeout(deadline, name, "stop"));
    try {
      const state = store.read();
      if (state === null) {
        return emptyResult(name);
      }
      const stopped = await this.stopLocked(store, state, owner.ownerToken, deadline);
      return resultFromState(stopped, false);
    } finally {
      release();
    }
  }

  async destroy(nameOption?: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<InstanceResult> {
    const name = this.resolveName(nameOption);
    const deadline = Date.now() + timeoutMs;
    const store = this.store(name);
    if (!existsSync(store.paths.owner)) {
      return emptyResult(name);
    }
    const owner = store.readOwner();
    const release = await store.lock(owner.ownerToken, remainingTimeout(deadline, name, "destroy"));
    try {
      let state = store.read();
      if (state === null) {
        safeRemoveOwned(
          store.paths.root,
          dirname(store.paths.root),
          store.paths.root,
          owner.ownerToken,
          "owner.json",
        );
        return emptyResult(name);
      }
      if (store.activeExecs(owner.ownerToken).length > 0) {
        throw new DevError(
          "instance_busy",
          `Instance ${name} has an active bb command.`,
          "Wait for dev exec to finish, then retry destroy.",
        );
      }
      if (completePlan(state) === null) {
        this.destroyPreRuntime(store, state, owner.ownerToken);
        return emptyResult(name);
      }
      let plan: InstancePlan & { target: LauncherTarget; leaseKey: string };
      if (state.phase === "destroying") {
        plan = requireCompletePlan(state);
      } else {
        state = await this.stopLocked(store, state, owner.ownerToken, deadline);
        plan = requireCompletePlan(state);
        const live = readLauncherStatus(launcherOptions(plan, this.environment));
        assertSameStoredTarget(plan.target, live);
        plan = { ...plan, target: live };
        state = checkpoint(state, { phase: "destroying", plan, step: "checkout" });
        store.write(state);
      }

      if (state.phase !== "destroying") {
        throw new DevError(
          "invalid_state",
          `Instance ${name} did not enter the destroying checkpoint.`,
          "Inspect state.json before retrying destroy.",
        );
      }
      let destroyStep = state.step;
      if (destroyStep === "runtime") {
        state = checkpoint(state, { phase: "destroying", plan, step: "checkout" });
        store.write(state);
        destroyStep = "checkout";
      }
      if (destroyStep === "checkout") {
        safeRemoveOwned(plan.checkoutPath, store.paths.root, plan.checkoutPath, owner.ownerToken);
        state = checkpoint(state, { phase: "destroying", plan, step: "external" });
        store.write(state);
        destroyStep = "external";
      }
      if (destroyStep === "external") {
        safeRemoveOwned(
          plan.target.dataDir,
          dirname(plan.target.dataDir),
          plan.target.dataDir,
          owner.ownerToken,
        );
        const logRoot = dirname(plan.target.launcherLog);
        safeRemoveOwned(logRoot, dirname(logRoot), logRoot, owner.ownerToken);
        state = checkpoint(state, { phase: "destroying", plan, step: "lease" });
        store.write(state);
        destroyStep = "lease";
      }
      if (destroyStep === "lease") {
        releaseLease(this.home, plan.leaseKey, owner.ownerToken);
      }
      safeRemoveOwned(
        store.paths.root,
        dirname(store.paths.root),
        store.paths.root,
        owner.ownerToken,
        "owner.json",
      );
      return emptyResult(name);
    } finally {
      release();
    }
  }

  environmentFor(nameOption?: string): EnvironmentResult {
    const name = this.resolveName(nameOption);
    const state = this.requiredState(name);
    const plan = requireCompletePlan(state);
    return {
      name,
      BB_CLI: plan.shimPath,
      BB_SERVER_URL: plan.target.appUrl,
      BB_HOST_DAEMON_PORT: String(plan.target.hostDaemonPort),
      BB_KIT_DEV_NAME: name,
    };
  }

  finiteLogs(
    nameOption: string | undefined,
    target: "dev" | "desktop" | "launcher",
    lines: number,
  ): string {
    const state = this.requiredState(this.resolveName(nameOption));
    const plan = requireCompletePlan(state);
    const path = logPath(plan.target, target);
    if (!existsSync(path)) {
      return "";
    }
    const content = readFileSync(path, "utf8");
    const selected = content.replace(/\n$/, "").split("\n").slice(-lines).join("\n");
    return selected === "" ? "" : `${selected}\n`;
  }

  async followLogs(
    nameOption: string | undefined,
    target: "dev" | "desktop" | "launcher",
    lines: number,
  ): Promise<number> {
    const state = this.requiredState(this.resolveName(nameOption));
    const plan = requireCompletePlan(state);
    return inheritProcess("tail", ["-n", String(lines), "-f", logPath(plan.target, target)]);
  }

  async exec(
    nameOption: string | undefined,
    args: readonly string[],
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<number> {
    const name = this.resolveName(nameOption);
    const store = this.store(name);
    const owner = store.readOwner();
    const release = await store.lock(owner.ownerToken, timeoutMs);
    let execRecord: string | null = null;
    let child: ReturnType<typeof spawn> | null = null;
    try {
      const state = store.read();
      if (state === null) {
        throw new DevError(
          "instance_not_found",
          `Instance ${name} does not exist.`,
          "Run bb-kit dev-instance start first.",
        );
      }
      const plan = requireCompletePlan(state);
      child = spawn(plan.shimPath, [...args], {
        stdio: "inherit",
        cwd: this.cwd,
        env: this.environment,
      });
      const pid = child.pid;
      const identity = pid === undefined ? null : processIdentity(pid);
      if (identity === null) {
        child.kill();
        throw new DevError(
          "process_identity_unavailable",
          "Could not record the bb command process identity.",
          "Retry from a normal local shell.",
        );
      }
      execRecord = store.addExec(owner.ownerToken, identity);
    } finally {
      release();
    }
    if (child === null || execRecord === null) {
      return 1;
    }
    const exitCode = await waitForChild(child);
    try {
      const cleanupRelease = await store.lock(owner.ownerToken, timeoutMs);
      try {
        store.removeExec(execRecord);
      } finally {
        cleanupRelease();
      }
    } catch {
      return exitCode;
    }
    return exitCode;
  }

  private async prepare(
    store: InstanceStore,
    state: InstanceState,
    initialPlan: InstancePlan,
    ownerToken: string,
  ): Promise<InstanceState> {
    let plan = initialPlan;
    if (plan.target !== null && plan.leaseKey !== null) {
      const live = readLauncherStatus(launcherOptions(plan, this.environment));
      assertSameStoredTarget(plan.target, live);
      const complete = { ...plan, target: live, leaseKey: plan.leaseKey };
      const leaseClaimed = claimLease(this.home, plan.leaseKey, ownerToken, state.name);
      const portsBusy = await Promise.all([
        this.portProbe(live.appPort),
        this.portProbe(live.serverPort),
        this.portProbe(live.hostDaemonPort),
      ]);
      const launcherOwnsRuntime =
        live.devSession === "running" || live.desktopSession === "running";
      if (leaseClaimed && (!portsBusy.some(Boolean) || launcherOwnsRuntime)) {
        ensureOwnedDirectory(live.dataDir, ownerToken, "data");
        ensureOwnedDirectory(dirname(live.launcherLog), ownerToken, "logs");
        writeShim(complete, store.paths.bin);
        const prepared = checkpoint(state, { phase: "prepared", plan: complete });
        store.write(prepared);
        return prepared;
      }
      if (launcherOwnsRuntime) {
        throw new DevError(
          "lease_mismatch",
          `Running launcher target for ${state.name} has another lease owner.`,
          "Do not stop or replace it. Inspect the lease and state.json.",
        );
      }
      if (leaseClaimed) {
        releaseLease(this.home, plan.leaseKey, ownerToken);
      }
      safeRemoveOwned(
        plan.target.dataDir,
        dirname(plan.target.dataDir),
        plan.target.dataDir,
        ownerToken,
      );
      safeRemoveOwned(plan.checkoutPath, store.paths.root, plan.checkoutPath, ownerToken);
      plan = this.newPlan(
        store,
        state.name,
        ownerToken,
        plan.revision,
        plan.desiredRuntime,
        checkoutIndex(plan.checkoutPath) + 1,
      );
    }

    for (
      let candidate = checkoutIndex(plan.checkoutPath);
      candidate < MAX_CHECKOUT_CANDIDATES;
      candidate += 1
    ) {
      if (candidate > checkoutIndex(plan.checkoutPath)) {
        plan = this.newPlan(
          store,
          state.name,
          ownerToken,
          plan.revision,
          plan.desiredRuntime,
          candidate,
        );
      }
      state = checkpoint(state, { phase: "preparing", step: "checkout", plan });
      store.write(state);
      this.progress(
        `Preparing ${basename(plan.checkoutPath)} at ${plan.revision.commit.slice(0, 12)}`,
      );
      prepareCheckout(plan, ownerToken);
      assertLauncherSupported(launcherOptions(plan, this.environment));
      const target = readLauncherStatus(launcherOptions(plan, this.environment));
      const leaseKey = leaseKeyFor(target);
      const complete = { ...plan, target, leaseKey };
      state = checkpoint(state, { phase: "preparing", step: "external", plan: complete });
      store.write(state);

      const leaseClaimed = claimLease(this.home, leaseKey, ownerToken, state.name);
      const portsBusy = await Promise.all([
        this.portProbe(target.appPort),
        this.portProbe(target.serverPort),
        this.portProbe(target.hostDaemonPort),
      ]);
      if (leaseClaimed && !portsBusy.some(Boolean)) {
        ensureOwnedDirectory(target.dataDir, ownerToken, "data");
        ensureOwnedDirectory(dirname(target.launcherLog), ownerToken, "logs");
        writeShim(complete, store.paths.bin);
        const prepared = checkpoint(state, { phase: "prepared", plan: complete });
        store.write(prepared);
        return prepared;
      }
      if (leaseClaimed) {
        releaseLease(this.home, leaseKey, ownerToken);
      }
      safeRemoveOwned(plan.checkoutPath, store.paths.root, plan.checkoutPath, ownerToken);
    }
    throw new DevError(
      "ports_busy",
      `Could not find free launcher ports for instance ${state.name}.`,
      "Stop the conflicting bb instances, then retry start.",
    );
  }

  private async stopLocked(
    store: InstanceStore,
    state: InstanceState,
    ownerToken: string,
    deadline: number,
  ): Promise<InstanceState> {
    if (state.phase === "destroying") {
      throw new DevError(
        "instance_destroying",
        `Instance ${state.name} has an incomplete destroy operation.`,
        "Run bb-kit dev-instance destroy again.",
      );
    }
    if (store.activeExecs(ownerToken).length > 0) {
      throw new DevError(
        "instance_busy",
        `Instance ${state.name} has an active bb command.`,
        "Wait for dev exec to finish, then retry stop.",
      );
    }
    const plan = requireCompletePlan(state);
    const launcher = launcherOptions(plan, this.environment);
    const live = readLauncherStatus(launcher);
    assertSameStoredTarget(plan.target, live);
    assertLeaseOwned(this.home, plan.leaseKey, ownerToken);
    const ports = await Promise.all([
      this.portProbe(live.appPort),
      this.portProbe(live.serverPort),
      this.portProbe(live.hostDaemonPort),
    ]);
    if (live.devSession === "stopped" && ports.some(Boolean)) {
      throw new DevError(
        "ambiguous_launcher_target",
        `Instance ${state.name} has no dev session but its target ports are occupied.`,
        "Stop the conflicting listeners before retrying stop or destroy.",
      );
    }
    if (live.devSession === "stopped" && live.desktopSession === "stopped") {
      const prepared = checkpoint(state, { phase: "prepared", plan: { ...plan, target: live } });
      store.write(prepared);
      return prepared;
    }
    let stopping = checkpoint(state, {
      phase: "stopping",
      plan: { ...plan, target: live },
      child: null,
    });
    store.write(stopping);
    let exitCode: number;
    try {
      exitCode = await runLauncherCommand(
        launcher,
        ["stop"],
        live.launcherLog,
        (child) => {
          stopping = checkpoint(stopping, {
            phase: "stopping",
            plan: { ...plan, target: live },
            child,
          });
          store.write(stopping);
        },
        remainingTimeout(deadline, state.name, "stop"),
      );
    } catch (error) {
      const failure = asDevError(error);
      store.write(failedFromPlan(stopping, { ...plan, target: live }, failure, "stop"));
      throw failure;
    }
    if (exitCode !== 0) {
      const failure = new DevError(
        "launcher_stop_failed",
        `Launcher stop exited with status ${exitCode} for instance ${state.name}.`,
        "Inspect the launcher log and retry stop.",
        { logPath: live.launcherLog },
      );
      store.write(failedFromPlan(stopping, { ...plan, target: live }, failure, "stop"));
      throw failure;
    }
    const stoppedTarget = readLauncherStatus(launcher);
    assertSameStoredTarget(live, stoppedTarget);
    if (stoppedTarget.devSession !== "stopped" || stoppedTarget.desktopSession !== "stopped") {
      throw new DevError(
        "launcher_stop_failed",
        `Launcher sessions survived stop for instance ${state.name}.`,
        "Inspect the launcher log and retry stop.",
      );
    }
    const prepared = checkpoint(stopping, {
      phase: "prepared",
      plan: { ...plan, target: stoppedTarget },
    });
    store.write(prepared);
    return prepared;
  }

  private createResolvingState(
    name: string,
    ownerToken: string,
    request: RevisionRequest,
    desiredRuntime: DesiredRuntime,
    repositoryOption?: string,
  ): InstanceState {
    const now = new Date().toISOString();
    const configuredRepository = repositoryOption ?? this.environment["BB_KIT_BB_REPO"];
    const selected = configuredRepository === "" ? undefined : configuredRepository;
    const repository =
      request.kind === "latest"
        ? OFFICIAL_REPOSITORY
        : (selected ??
          (request.kind === "local" || request.kind === "origin"
            ? join(homedir(), "git", "bb")
            : OFFICIAL_REPOSITORY));
    return {
      schemaVersion: STATE_SCHEMA_VERSION,
      name,
      ownerToken,
      createdAt: now,
      updatedAt: now,
      phase: "resolving",
      request,
      repository,
      resolverPath:
        request.kind === "commit" && repository === OFFICIAL_REPOSITORY
          ? join(this.home, "instances", name, "resolver")
          : null,
      desiredRuntime,
    };
  }

  private async resolveForState(
    request: RevisionRequest,
    repository: string | undefined,
    instanceRoot: string,
    ownerToken: string,
  ): Promise<ResolvedRevision> {
    return resolveRevision(request, {
      repositoryOption: repository,
      environment: this.environment,
      resolverPath: join(instanceRoot, "resolver"),
      ownerToken,
    });
  }

  private newPlan(
    store: InstanceStore,
    name: string,
    ownerToken: string,
    revision: ResolvedRevision,
    desiredRuntime: DesiredRuntime,
    candidate: number,
  ): InstancePlan {
    const instanceRoot = realpathSync(store.paths.root);
    const checkoutPath = join(instanceRoot, candidate === 0 ? "checkout" : `checkout-${candidate}`);
    return {
      revision,
      checkoutPath,
      launcherPath: join(checkoutPath, "scripts", "bb-dev-app"),
      launcherName: `bb-kit-${sanitizeName(name)}-${ownerToken.slice(0, 8)}`,
      desiredRuntime,
      shimPath: join(store.paths.bin, "bb"),
      leaseKey: null,
      target: null,
    };
  }

  private removeResolver(instanceRoot: string, ownerToken: string): void {
    const path = join(instanceRoot, "resolver");
    if (existsSync(path)) {
      safeRemoveOwned(path, instanceRoot, path, ownerToken);
    }
  }

  private destroyPreRuntime(store: InstanceStore, state: InstanceState, ownerToken: string): void {
    const plan = statePlan(state);
    if (plan !== null) {
      if (plan.target !== null || plan.leaseKey !== null) {
        throw new DevError(
          "cleanup_refused",
          `Instance ${state.name} has an incomplete external target.`,
          "Inspect state.json before retrying destroy.",
        );
      }
      safeRemoveOwned(plan.checkoutPath, store.paths.root, plan.checkoutPath, ownerToken);
    }
    const resolverPath =
      state.phase === "resolving"
        ? state.resolverPath
        : state.phase === "failed" && state.plan === null
          ? state.resolving?.resolverPath
          : null;
    if (resolverPath !== null && resolverPath !== undefined) {
      const expected = join(store.paths.root, "resolver");
      if (resolve(resolverPath) !== resolve(expected)) {
        throw new DevError(
          "cleanup_refused",
          `Resolver path ${resolverPath} is not the recorded instance resolver.`,
          "Inspect state.json before retrying destroy.",
        );
      }
      safeRemoveOwned(resolverPath, store.paths.root, resolverPath, ownerToken);
    }
    safeRemoveOwned(
      store.paths.root,
      dirname(store.paths.root),
      store.paths.root,
      ownerToken,
      "owner.json",
    );
  }

  private requiredState(name: string): InstanceState {
    const store = this.store(name);
    const state = store.read();
    if (state === null) {
      throw new DevError(
        "instance_not_found",
        `Instance ${name} does not exist.`,
        "Run bb-kit dev-instance start first.",
      );
    }
    return state;
  }

  private store(name: string): InstanceStore {
    return new InstanceStore(instancePaths(this.home, name));
  }
}

function sanitizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
}

function hashedName(prefix: string, path: string): string {
  const hash = createHash("sha256").update(path).digest("hex").slice(0, 12);
  const label = sanitizeName(basename(path)).slice(0, 32) || prefix;
  return `${prefix}-${label}-${hash}`;
}

function realpathOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function checkoutIndex(path: string): number {
  const match = /\/checkout-(\d+)$/.exec(path);
  return match?.[1] === undefined ? 0 : Number(match[1]);
}

function remainingTimeout(deadline: number, name: string, operation: string): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new DevError(
      "operation_timeout",
      `Instance ${name} exceeded its ${operation} timeout.`,
      `Retry ${operation} after inspecting the instance state and launcher log.`,
    );
  }
  return remaining;
}

function ownerMismatch(name: string): never {
  throw new DevError(
    "owner_mismatch",
    `State for instance ${name} has another owner token.`,
    "Inspect the instance root before retrying.",
  );
}
