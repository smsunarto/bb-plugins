import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { DevError, asDevError } from "./error.ts";
import { leaseKeyFor, logPath, openApp, probeApp, writeShim } from "./launcher.ts";
import {
  assertRuntimeEnvContract,
  checkoutTarget,
  clearRuntimeRecord,
  desktopIsRunning,
  ensureDependencies,
  portsFor,
  readRuntimeRecord,
  readToolchain,
  runtimeIsRunning,
  runtimePortOffset,
  runtimePorts,
  runtimeTarget,
  startRuntimeProcess,
  stopRuntimeProcess,
  writeRuntimeRecord,
  type RuntimePorts,
} from "./runtime.ts";
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
  type CompleteInstancePlan,
  type EnvironmentResult,
  type InstancePlan,
  type InstanceResult,
  type InstanceState,
  type LauncherTarget,
  type OwnedInstancePlan,
  type ProcessIdentity,
  type RuntimeInstancePlan,
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
import { routedEnvironment } from "./routing.ts";
import { resolveAttachedCheckout } from "./source.ts";
import {
  assertLeaseOwned,
  claimLease,
  ensureOwnedDirectory,
  InstanceStore,
  releaseLease,
  safeRemoveOwned,
  type SingletonExecHandle,
  type SingletonExecSpec,
} from "./store.ts";

const DEFAULT_CONTROL_TIMEOUT_MS = 30_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 30_000;
const MAX_CHECKOUT_CANDIDATES = 16;
const MAX_RUNTIME_PORT_CANDIDATES = 64;

async function readChildStream(stream: Readable | null): Promise<string> {
  if (stream === null) return "";
  let value = "";
  for await (const chunk of stream) value += chunk.toString();
  return value;
}

export type ManagerOptions = {
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  healthProbe?: (url: string) => Promise<boolean>;
  /** The seam tests drive --open through, so no test opens a real browser. */
  opener?: (url: string) => void;
  portProbe?: (port: number) => Promise<boolean>;
  progress?: (message: string) => void;
  /** The seam tests drive a dev stack through, beside healthProbe and portProbe. */
  runtimeSpawn?: typeof startRuntimeProcess;
  /** The seam tests drive the install step through, so no test runs pnpm. */
  installDependencies?: typeof ensureDependencies;
  /** The seam tests resolve revisions through, so no test contacts get-bb/bb. */
  resolveRevision?: typeof resolveRevision;
};

export type StartOptions = {
  name?: string;
  revision?: string;
  repository?: string;
  attach?: string;
  desktop?: boolean;
  open?: boolean;
  timeoutMs?: number;
  /** Borrow this instance's checkout instead of owning one. */
  from?: string;
  /** Own a checkout even when a sibling instance could have been borrowed. */
  owned?: boolean;
};

export type CapturedCommand = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type SingletonRunOptions = {
  key: string;
  cwd?: string;
  stdout?: "inherit" | "stderr";
};

export type SingletonRunResult = { kind: "reused" } | { kind: "exited"; exitCode: number };

export type { EnvironmentResult, InstanceResult } from "./model.ts";

export class DevManager {
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly home: string;
  private readonly healthProbe: (url: string) => Promise<boolean>;
  private readonly opener: (url: string) => void;
  private readonly portProbe: (port: number) => Promise<boolean>;
  private readonly progress: (message: string) => void;
  private readonly runtimeSpawn: typeof startRuntimeProcess;
  private readonly installDependencies: typeof ensureDependencies;
  private readonly resolver: typeof resolveRevision;

  constructor(options: ManagerOptions = {}) {
    this.cwd = resolve(options.cwd ?? process.cwd());
    this.environment = options.environment ?? process.env;
    this.home = devHome(this.environment);
    this.healthProbe = options.healthProbe ?? probeApp;
    this.opener = options.opener ?? openApp;
    this.portProbe = options.portProbe ?? isPortListening;
    this.progress = options.progress ?? (() => {});
    this.runtimeSpawn = options.runtimeSpawn ?? startRuntimeProcess;
    this.installDependencies = options.installDependencies ?? ensureDependencies;
    this.resolver = options.resolveRevision ?? resolveRevision;
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
    const routedName = this.environment["BB_KIT_DEV_NAME"];
    if (routedName !== undefined && routedName !== "") {
      return this.resolveName(routedName);
    }
    const gitRoot = runCommand("git", ["-C", this.cwd, "rev-parse", "--show-toplevel"]);
    if (gitRoot.status === 0 && gitRoot.stdout.trim() !== "") {
      return hashedName("workspace", realpathOrResolved(gitRoot.stdout.trim()));
    }
    const environmentId = this.environment["BB_ENVIRONMENT_ID"];
    if (environmentId !== undefined && environmentId !== "") {
      const sanitized = sanitizeName(environmentId);
      if (sanitized !== "") {
        const hash = createHash("sha256").update(environmentId).digest("hex").slice(0, 10);
        return `environment-${sanitized.slice(0, 40)}-${hash}`;
      }
    }
    return hashedName("directory", realpathOrResolved(this.cwd));
  }

  async start(options: StartOptions = {}): Promise<InstanceResult> {
    if (
      options.attach !== undefined &&
      (options.revision !== undefined || options.repository !== undefined)
    ) {
      throw new DevError(
        "invalid_arguments",
        "--attach cannot be combined with --revision or --repo.",
        "Choose an attached checkout or an owned revision.",
      );
    }
    if (options.repository !== undefined && options.revision === undefined) {
      throw new DevError(
        "invalid_arguments",
        "--repo requires --revision.",
        "Pass both options, or omit --repo to use the latest official release.",
      );
    }
    if (options.from !== undefined && options.owned === true) {
      throw new DevError(
        "invalid_arguments",
        "--from cannot be combined with --owned.",
        "Borrow a checkout or prepare one, not both.",
      );
    }
    if (options.from !== undefined && options.attach !== undefined) {
      throw new DevError(
        "invalid_arguments",
        "--from cannot be combined with --attach.",
        "An attached checkout is already someone else's.",
      );
    }
    const name = this.resolveName(options.name);
    const attachedPath =
      options.attach === undefined ? undefined : resolveAttachedCheckout(options.attach, this.cwd);
    const deadline = options.timeoutMs === undefined ? null : Date.now() + options.timeoutMs;
    const store = this.store(name);
    const owner = store.claim(name);
    const release = await store.lock(
      owner.ownerToken,
      deadline === null ? DEFAULT_CONTROL_TIMEOUT_MS : remainingTimeout(deadline, name, "start"),
    );
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

      if (state === null && attachedPath !== undefined) {
        const now = new Date().toISOString();
        const plan = this.newAttachedPlan(store, attachedPath, desired);
        state = {
          schemaVersion: STATE_SCHEMA_VERSION,
          name,
          ownerToken: owner.ownerToken,
          createdAt: now,
          updatedAt: now,
          phase: "preparing",
          step: "checkout",
          plan,
        };
        store.write(state);
      } else if (state === null) {
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
      if (plan !== null && attachedPath !== undefined) {
        if (plan.source !== "attached" || plan.checkoutPath !== attachedPath) {
          throw new DevError(
            "source_mismatch",
            `Instance ${name} owns ${describeSource(plan)}, not attached checkout ${attachedPath}.`,
            "Choose another --name or destroy this stopped instance first.",
          );
        }
      }
      // `--revision latest` on an owned instance is not a pin to check but a
      // request to track releases, so it skips the mismatch check and joins the
      // refresh below, which moves the checkout when a newer release exists.
      const adoptLatest =
        plan !== null && plan.source === "owned" && explicitRequest?.kind === "latest";
      if (plan !== null && explicitRequest !== undefined && !adoptLatest) {
        // A runtime pins a revision too -- the one its source checkout is on --
        // so it is checked the same way. Only an attached checkout has none.
        if (plan.source === "attached") {
          throw new DevError(
            "source_mismatch",
            `Instance ${name} owns attached checkout ${plan.checkoutPath}, not an owned revision.`,
            "Choose another --name or destroy this stopped instance first.",
          );
        }
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

      if (
        plan !== null &&
        plan.source === "owned" &&
        (adoptLatest || plan.revision.selector === "latest")
      ) {
        const refreshed = await this.refreshLatest(store, state, plan, owner.ownerToken, deadline);
        state = refreshed.state;
        plan = refreshed.plan;
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
          // An unnamed start is the workspace host: it owns the checkout every
          // runtime borrows, so it never borrows one itself.
          const borrowFrom =
            options.owned === true || (options.name === undefined && options.from === undefined)
              ? null
              : this.findRuntimeSource(name, revision, options.from);
          if (borrowFrom !== null) {
            this.progress(`Borrowing ${borrowFrom.name}'s checkout for ${name}`);
          }
          plan =
            borrowFrom === null
              ? this.newOwnedPlan(store, name, revision, desired, 0)
              : this.newRuntimePlan(store, name, revision, desired, borrowFrom);
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
      let live = this.liveTarget(store, completePlan);
      const livePlan = { ...completePlan, target: live, desiredRuntime: desired };
      plan = livePlan;

      if (await this.satisfied(live, desired)) {
        state = checkpoint(state, {
          phase: "running",
          plan: livePlan,
          observedAt: new Date().toISOString(),
        });
        store.write(state);
        if (options.open === true) {
          this.openApp(live.appUrl);
        }
        return resultFromState(state, true);
      }

      if (store.activeExecs(owner.ownerToken).length > 0) {
        throw new DevError(
          "instance_busy",
          `Instance ${name} has an active routed command.`,
          "Wait for dev-instance exec or dev-instance run to finish, then retry start.",
        );
      }

      this.progress(
        plan.source === "attached"
          ? `Starting ${name} from ${plan.checkoutPath}`
          : `Starting ${name} at ${plan.revision.label}`,
      );
      const startingPlan = requireTargetPlan(plan);
      const stateBeforeStart = state;
      const checkpointChild = (child: ProcessIdentity): void => {
        state = checkpoint(stateBeforeStart, { phase: "starting", plan: startingPlan, child });
        store.write(state);
      };
      try {
        if (live.devSession === "running" || live.desktopSession === "running") {
          // Up but not serving what was asked: a stack still booting from a
          // start that timed out, or a web stack that now needs the desktop
          // shell too. One stack per target, so it is replaced, not joined.
          this.progress(`Restarting ${name}'s dev stack`);
          await stopRuntimeProcess(readRuntimeRecord(store.paths.root));
          clearRuntimeRecord(store.paths.root);
        }
        if (startingPlan.source !== "runtime") {
          // A runtime borrows a checkout its source already installed.
          this.progress(`Installing dependencies for ${name}`);
          await this.installDependencies({
            checkoutPath: startingPlan.checkoutPath,
            logPath: startingPlan.target.launcherLog,
            environment: this.environment,
            onSpawn: checkpointChild,
            deadline,
          });
        }
        // bb-kit owns every stack it starts, so it records the process it has
        // to be able to stop later.
        const started = this.runtimeSpawn({
          checkoutPath: startingPlan.checkoutPath,
          target: startingPlan.target,
          ports: portsFor(startingPlan.target),
          homeDir: this.homeDirectory(),
          base: this.environment,
          desktop: desired === "desktop",
        });
        writeRuntimeRecord(store.paths.root, started);
        checkpointChild(started.identity);
      } catch (error) {
        const failure = asDevError(error);
        store.write(failedFromPlan(state, startingPlan, failure, "start"));
        throw failure;
      }

      const healthDeadline = deadline ?? Date.now() + DEFAULT_HEALTH_TIMEOUT_MS;
      while (true) {
        live = this.liveTarget(store, startingPlan);
        if (await this.satisfied(live, desired)) {
          break;
        }
        // Waiting out the full health timeout on a process that already died
        // hides the reason, which is in the log this points at.
        const desktopDied = desired === "desktop" && live.desktopSession === "stopped";
        if (live.devSession === "stopped" || desktopDied) {
          const failure = new DevError(
            "runtime_start_failed",
            `Instance ${name} exited before it became healthy.`,
            `Inspect the ${desktopDied ? "desktop" : "dev"} log and retry start.`,
            { logPath: desktopDied ? live.desktopLog : live.devLog },
          );
          store.write(failedFromPlan(state, { ...startingPlan, target: live }, failure, "start"));
          throw failure;
        }
        if (Date.now() >= healthDeadline) {
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
        this.openApp(live.appUrl);
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
    if (plan?.target === null || plan === null) {
      return resultFromState(state, false);
    }
    try {
      const live = this.liveTarget(store, plan);
      const running = await this.satisfied(live, plan.desiredRuntime);
      return {
        ...resultFromState(state, running, live),
        phase: running ? "running" : "stopped",
      };
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

  async stop(nameOption?: string, timeoutMs = DEFAULT_CONTROL_TIMEOUT_MS): Promise<InstanceResult> {
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

  async destroy(
    nameOption?: string,
    timeoutMs = DEFAULT_CONTROL_TIMEOUT_MS,
  ): Promise<InstanceResult> {
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
          `Instance ${name} has an active routed command.`,
          "Wait for dev-instance exec or dev-instance run to finish, then retry destroy.",
        );
      }
      if (completePlan(state) === null) {
        await this.destroyPreRuntime(store, state, owner.ownerToken);
        return emptyResult(name);
      }
      let plan: CompleteInstancePlan;
      if (state.phase === "destroying") {
        plan = requireCompletePlan(state);
      } else {
        state = await this.stopLocked(store, state, owner.ownerToken, deadline);
        plan = requireCompletePlan(state);
        plan = { ...plan, target: this.liveTarget(store, plan) };
        state = checkpoint(state, {
          phase: "destroying",
          plan,
          step: firstDestroyStep(plan.source),
        });
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
        destroyStep = firstDestroyStep(plan.source);
        state = checkpoint(state, { phase: "destroying", plan, step: destroyStep });
        store.write(state);
      }
      if (destroyStep === "checkout") {
        // Only an owned instance has a checkout of its own. A runtime borrows
        // one and must never remove it.
        if (plan.source !== "owned") {
          throw new DevError(
            "invalid_state",
            `Instance ${name} owns no checkout but entered checkout cleanup.`,
            "Inspect state.json before retrying destroy.",
          );
        }
        await this.removeOwnedCheckout(store, plan, owner.ownerToken);
        state = checkpoint(state, { phase: "destroying", plan, step: "external" });
        store.write(state);
        destroyStep = "external";
      }
      if (destroyStep === "external") {
        if (plan.source === "attached") {
          throw new DevError(
            "invalid_state",
            `Attached instance ${name} entered owned external cleanup.`,
            "Inspect state.json before retrying destroy.",
          );
        }
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
    return this.environmentForPlan(name, plan);
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
    timeoutMs = DEFAULT_CONTROL_TIMEOUT_MS,
  ): Promise<number> {
    return (
      await this.runTracked(
        nameOption,
        (plan) => [plan.shimPath, ...args] as [string, ...string[]],
        false,
        timeoutMs,
      )
    ).exitCode;
  }

  async captureExec(
    nameOption: string | undefined,
    args: readonly string[],
    timeoutMs = DEFAULT_CONTROL_TIMEOUT_MS,
  ): Promise<CapturedCommand> {
    return this.runTracked(
      nameOption,
      (plan) => [plan.shimPath, ...args] as [string, ...string[]],
      false,
      timeoutMs,
      { stdout: "capture" },
    );
  }

  async run(
    nameOption: string | undefined,
    argv: readonly [string, ...string[]],
    options: { stdout?: "inherit" | "stderr"; cwd?: string } = {},
  ): Promise<number> {
    return (
      await this.runTracked(nameOption, () => argv, true, DEFAULT_CONTROL_TIMEOUT_MS, options)
    ).exitCode;
  }

  async runSingleton(
    nameOption: string | undefined,
    argv: readonly [string, ...string[]],
    options: SingletonRunOptions,
  ): Promise<SingletonRunResult> {
    const name = this.resolveName(nameOption);
    const store = this.store(name);
    const owner = store.readOwner();
    const cwd = realpathOrResolved(options.cwd ?? this.cwd);
    const spec: SingletonExecSpec = {
      cwd,
      key: options.key,
      commandDigest: createHash("sha256").update(JSON.stringify(argv)).digest("hex"),
    };
    const release = await store.lock(owner.ownerToken, DEFAULT_CONTROL_TIMEOUT_MS);
    let execRecord: SingletonExecHandle | null = null;
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
      if (!(await this.satisfied(this.liveTarget(store, plan), plan.desiredRuntime))) {
        throw new DevError(
          "instance_not_running",
          `Instance ${name} is not running.`,
          "Run bb-kit dev-instance start first.",
        );
      }
      const existing = store.reconcileSingleton(owner.ownerToken, spec);
      if (existing.kind === "reused") return existing;
      if (existing.kind === "legacy-conflict") {
        throw new DevError(
          "legacy_exec_ambiguous",
          `Instance ${name} has live commands without singleton ownership.`,
          "Stop the recorded legacy commands, then retry.",
          { pids: existing.identities.map((identity) => identity.pid) },
        );
      }
      const route = this.environmentForPlan(name, plan);
      child = spawn(argv[0], argv.slice(1), {
        stdio:
          options.stdout === "stderr" ? ["inherit", process.stderr, process.stderr] : "inherit",
        cwd,
        env: routedEnvironment(this.environment, route),
      });
      const pid = child.pid;
      const identity = pid === undefined ? null : processIdentity(pid);
      if (identity === null) {
        await terminateStartedChild(child);
        child = null;
        throw new DevError(
          "process_identity_unavailable",
          "Could not record the singleton command process identity.",
          "Retry from a normal local shell.",
        );
      }
      try {
        execRecord = store.addSingleton(owner.ownerToken, spec, identity);
      } catch (error) {
        await terminateStartedChild(child);
        child = null;
        throw error;
      }
    } finally {
      release();
    }
    if (child === null || execRecord === null) {
      return { kind: "exited", exitCode: 1 };
    }
    const exitCode = await waitForChild(child);
    try {
      const cleanupRelease = await store.lock(owner.ownerToken, DEFAULT_CONTROL_TIMEOUT_MS);
      try {
        store.removeSingleton(execRecord);
      } finally {
        cleanupRelease();
      }
    } catch {
      return { kind: "exited", exitCode };
    }
    return { kind: "exited", exitCode };
  }

  private async runTracked(
    nameOption: string | undefined,
    command: (plan: CompleteInstancePlan) => readonly [string, ...string[]],
    requireRunning: boolean,
    timeoutMs: number,
    options: { stdout?: "inherit" | "stderr" | "capture"; cwd?: string } = {},
  ): Promise<CapturedCommand> {
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
      if (requireRunning) {
        if (!(await this.satisfied(this.liveTarget(store, plan), plan.desiredRuntime))) {
          throw new DevError(
            "instance_not_running",
            `Instance ${name} is not running.`,
            "Run bb-kit dev-instance start first.",
          );
        }
      }
      const argv = command(plan);
      const route = this.environmentForPlan(name, plan);
      child = spawn(argv[0], argv.slice(1), {
        stdio:
          options.stdout === "capture"
            ? ["inherit", "pipe", "pipe"]
            : options.stdout === "stderr"
              ? ["inherit", process.stderr, process.stderr]
              : "inherit",
        cwd: options.cwd === undefined ? this.cwd : resolve(options.cwd),
        env: routedEnvironment(this.environment, route),
      });
      const pid = child.pid;
      const identity = pid === undefined ? null : processIdentity(pid);
      if (identity === null) {
        child.kill();
        throw new DevError(
          "process_identity_unavailable",
          "Could not record the routed command process identity.",
          "Retry from a normal local shell.",
        );
      }
      execRecord = store.addExec(owner.ownerToken, identity);
    } finally {
      release();
    }
    if (child === null || execRecord === null) {
      return { exitCode: 1, stdout: "", stderr: "" };
    }
    const stdout = readChildStream(child.stdout);
    const stderr = readChildStream(child.stderr);
    const [exitCode, capturedStdout, capturedStderr] = await Promise.all([
      waitForChild(child),
      stdout,
      stderr,
    ]);
    try {
      const cleanupRelease = await store.lock(owner.ownerToken, timeoutMs);
      try {
        store.removeExec(execRecord);
      } finally {
        cleanupRelease();
      }
    } catch {
      return { exitCode, stdout: capturedStdout, stderr: capturedStderr };
    }
    return { exitCode, stdout: capturedStdout, stderr: capturedStderr };
  }

  private environmentForPlan(name: string, plan: CompleteInstancePlan): EnvironmentResult {
    return {
      name,
      BB_CLI: plan.shimPath,
      BB_SERVER_URL: plan.target.appUrl,
      BB_HOST_DAEMON_PORT: String(plan.target.hostDaemonPort),
      BB_KIT_DEV_NAME: name,
      BB_KIT_DEV_SOURCE: plan.source,
    };
  }

  private async prepare(
    store: InstanceStore,
    state: InstanceState,
    initialPlan: InstancePlan,
    ownerToken: string,
  ): Promise<InstanceState> {
    if (initialPlan.source === "attached") {
      return this.prepareAttached(store, state, initialPlan, ownerToken);
    }
    if (initialPlan.source === "runtime") {
      return this.prepareRuntime(store, state, initialPlan, ownerToken);
    }
    return this.prepareOwned(store, state, initialPlan, ownerToken);
  }

  private async prepareAttached(
    store: InstanceStore,
    state: InstanceState,
    plan: Extract<InstancePlan, { source: "attached" }>,
    ownerToken: string,
  ): Promise<InstanceState> {
    assertRuntimeEnvContract(plan.checkoutPath);
    const target = this.ownTarget(plan, state.name, ownerToken);
    const leaseKey = leaseKeyFor(target);
    const complete: CompleteInstancePlan = { ...plan, target, leaseKey };
    state = checkpoint(state, { phase: "preparing", step: "external", plan: complete });
    store.write(state);
    const leaseClaimed = claimLease(this.home, leaseKey, ownerToken, state.name);
    if (!leaseClaimed) {
      const failure = new DevError(
        "lease_mismatch",
        `Attached target for ${state.name} has another lease owner.`,
        "Use the instance that owns this checkout, or destroy its stopped record first.",
      );
      store.write(
        failedFromPlan(state, { ...plan, target: null, leaseKey: null }, failure, "preparation"),
      );
      throw failure;
    }
    if (plan.leaseKey !== null && plan.leaseKey !== leaseKey) {
      releaseLease(this.home, plan.leaseKey, ownerToken);
    }
    if ((await this.portsBusy(target)) && !this.ownsRunningStack(store, target)) {
      if (plan.leaseKey === null) {
        releaseLease(this.home, leaseKey, ownerToken);
      }
      const failure = new DevError(
        "target_ports_busy",
        `Attached instance ${state.name} has no dev stack but its target ports are occupied.`,
        "Stop the conflicting listeners before retrying start.",
      );
      if (plan.leaseKey === null) {
        store.write(
          failedFromPlan(state, { ...plan, target: null, leaseKey: null }, failure, "preparation"),
        );
      }
      throw failure;
    }
    // Not owned: an attached checkout's data and logs outlive the record.
    mkdirSync(target.dataDir, { recursive: true });
    mkdirSync(dirname(target.launcherLog), { recursive: true });
    writeShim(complete, store.paths.bin);
    const prepared = checkpoint(state, { phase: "prepared", plan: complete });
    store.write(prepared);
    return prepared;
  }

  private async prepareOwned(
    store: InstanceStore,
    state: InstanceState,
    initialPlan: OwnedInstancePlan,
    ownerToken: string,
  ): Promise<InstanceState> {
    let plan = initialPlan;
    if (plan.target !== null && plan.leaseKey !== null) {
      assertRuntimeEnvContract(plan.checkoutPath);
      const target = this.ownTarget(plan, state.name, ownerToken);
      const leaseKey = leaseKeyFor(target);
      const complete = { ...plan, target, leaseKey };
      const leaseClaimed = claimLease(this.home, leaseKey, ownerToken, state.name);
      const portsBusy = await this.portsBusy(target);
      const ownsRunningStack = this.ownsRunningStack(store, target);
      if (leaseClaimed && (!portsBusy || ownsRunningStack)) {
        if (plan.leaseKey !== leaseKey) {
          releaseLease(this.home, plan.leaseKey, ownerToken);
        }
        ensureOwnedDirectory(target.dataDir, ownerToken, "data");
        ensureOwnedDirectory(dirname(target.launcherLog), ownerToken, "logs");
        writeShim(complete, store.paths.bin);
        const prepared = checkpoint(state, { phase: "prepared", plan: complete });
        store.write(prepared);
        return prepared;
      }
      if (ownsRunningStack) {
        throw new DevError(
          "lease_mismatch",
          `Running target for ${state.name} has another lease owner.`,
          "Do not stop or replace it. Inspect the lease and state.json.",
        );
      }
      if (leaseClaimed) {
        releaseLease(this.home, leaseKey, ownerToken);
      }
      safeRemoveOwned(
        plan.target.dataDir,
        dirname(plan.target.dataDir),
        plan.target.dataDir,
        ownerToken,
      );
      await this.removeOwnedCheckout(store, plan, ownerToken);
      plan = this.newOwnedPlan(
        store,
        state.name,
        plan.revision,
        plan.desiredRuntime,
        checkoutIndex(plan.checkoutPath) + 1,
      );
    }

    // Ports derive from the checkout path, so a busy triple means another
    // checkout path, which is what the next candidate is.
    for (
      let candidate = checkoutIndex(plan.checkoutPath);
      candidate < MAX_CHECKOUT_CANDIDATES;
      candidate += 1
    ) {
      if (candidate > checkoutIndex(plan.checkoutPath)) {
        plan = this.newOwnedPlan(store, state.name, plan.revision, plan.desiredRuntime, candidate);
      }
      state = checkpoint(state, { phase: "preparing", step: "checkout", plan });
      store.write(state);
      this.progress(
        `Preparing ${basename(plan.checkoutPath)} at ${plan.revision.commit.slice(0, 12)}`,
      );
      prepareCheckout(plan, ownerToken);
      assertRuntimeEnvContract(plan.checkoutPath);
      const target = this.ownTarget(plan, state.name, ownerToken);
      const leaseKey = leaseKeyFor(target);
      const complete = { ...plan, target, leaseKey };
      state = checkpoint(state, { phase: "preparing", step: "external", plan: complete });
      store.write(state);

      // A stack this instance already runs on the checkout is its own, not a
      // conflict. Treating it as busy would send a live checkout to cleanup.
      const leaseClaimed = claimLease(this.home, leaseKey, ownerToken, state.name);
      const portsFree = !(await this.portsBusy(target)) || this.ownsRunningStack(store, target);
      if (leaseClaimed && portsFree) {
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
      await this.removeOwnedCheckout(store, plan, ownerToken);
    }
    throw new DevError(
      "ports_busy",
      `Could not find free ports for instance ${state.name}.`,
      "Stop the conflicting bb instances, then retry start.",
    );
  }

  /**
   * Remove an owned checkout once the dev stack it serves has stopped.
   *
   * Removing the directory first strands the whole Turbo dev tree with
   * nothing left on disk to find it by, and it runs until the machine
   * reboots. bb-kit records that tree in runtime.json, so stop it from the
   * record first. Stop is idempotent and a missing record is a no-op.
   */
  private async removeOwnedCheckout(
    store: InstanceStore,
    plan: OwnedInstancePlan,
    ownerToken: string,
  ): Promise<void> {
    await stopRuntimeProcess(readRuntimeRecord(store.paths.root));
    safeRemoveOwned(plan.checkoutPath, store.paths.root, plan.checkoutPath, ownerToken);
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
        `Instance ${state.name} has an active routed command.`,
        "Wait for dev-instance exec or dev-instance run to finish, then retry stop.",
      );
    }
    remainingTimeout(deadline, state.name, "stop");
    const plan = requireCompletePlan(state);
    const live = this.liveTarget(store, plan);
    assertLeaseOwned(this.home, plan.leaseKey, ownerToken);
    if (live.devSession === "stopped" && live.desktopSession === "stopped") {
      if (await this.portsBusy(live)) {
        throw new DevError(
          "target_ports_busy",
          `Instance ${state.name} has no dev stack but its target ports are occupied.`,
          "Stop the conflicting listeners before retrying stop or destroy.",
        );
      }
      clearRuntimeRecord(store.paths.root);
      const prepared = checkpoint(state, { phase: "prepared", plan: { ...plan, target: live } });
      store.write(prepared);
      return prepared;
    }
    // bb-kit started this process group, so bb-kit ends it.
    await stopRuntimeProcess(readRuntimeRecord(store.paths.root));
    clearRuntimeRecord(store.paths.root);
    const stoppedTarget = this.liveTarget(store, plan);
    if (stoppedTarget.devSession !== "stopped" || stoppedTarget.desktopSession !== "stopped") {
      const failure = new DevError(
        "runtime_stop_failed",
        `Instance ${state.name} survived stop.`,
        "Inspect the dev log and retry stop.",
        { logPath: live.devLog },
      );
      store.write(failedFromPlan(state, { ...plan, target: live }, failure, "stop"));
      throw failure;
    }
    const prepared = checkpoint(state, {
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
    currentCommit?: string,
  ): Promise<ResolvedRevision> {
    return this.resolver(request, {
      repositoryOption: repository,
      environment: this.environment,
      resolverPath: join(instanceRoot, "resolver"),
      ownerToken,
      currentCommit,
    });
  }

  /**
   * Keep an owned instance that tracks `latest` on the latest official release.
   *
   * Resolution runs when an instance is created, so without this a `latest`
   * instance would stay on whatever release was newest that day. Every start
   * asks get-bb/bb again. The same release is answered by one `ls-remote`. A
   * newer one moves the checkout in place, which keeps its installed
   * dependencies, after stopping the sessions that run from it; the start
   * that follows installs and builds the new release. A runtime
   * that is live on this checkout keeps the current release, as does an
   * unreachable repository: neither fails the start.
   */
  private async refreshLatest(
    store: InstanceStore,
    state: InstanceState,
    plan: OwnedInstancePlan,
    ownerToken: string,
    deadline: number | null,
  ): Promise<{ state: InstanceState; plan: OwnedInstancePlan }> {
    let resolved: ResolvedRevision;
    try {
      resolved = await this.resolveForState(
        { kind: "latest" },
        undefined,
        store.paths.root,
        ownerToken,
        plan.revision.commit,
      );
    } catch (error) {
      const failure = asDevError(error);
      this.progress(
        `Keeping ${state.name} at ${plan.revision.label}: could not check for a newer official release (${failure.message})`,
      );
      return { state, plan };
    } finally {
      this.removeResolver(store.paths.root, ownerToken);
    }
    if (resolved.repository !== plan.revision.repository) {
      throw new DevError(
        "source_mismatch",
        `Instance ${state.name} owns a checkout of ${plan.revision.repository}, not the official repository.`,
        "Choose another --name for the official release, or destroy this instance first.",
      );
    }
    if (resolved.commit === plan.revision.commit) {
      // Same release; a pinned instance adopting `latest` records the selector.
      return { state, plan: { ...plan, revision: resolved } };
    }
    const borrowers = this.liveBorrowers(state.name);
    if (borrowers.length > 0) {
      this.progress(
        `Keeping ${state.name} at ${plan.revision.label}: ${borrowers.join(", ")} ${borrowers.length === 1 ? "runs" : "run"} from its checkout. Stop ${borrowers.length === 1 ? "it" : "them"} to move to ${resolved.label}.`,
      );
      // Tracking is recorded now, so the move happens on a later start.
      return { state, plan: { ...plan, revision: { ...plan.revision, selector: "latest" } } };
    }
    if (store.activeExecs(ownerToken).length > 0) {
      // A routed command (plugin watchers, an exec) runs against the live
      // stack, and stop refuses while it does. The tracking is recorded so the
      // move happens on the first start after that command ends.
      this.progress(
        `Keeping ${state.name} at ${plan.revision.label}: an active routed command runs against it. Let it finish, then start again to move to ${resolved.label}.`,
      );
      return { state, plan: { ...plan, revision: { ...plan.revision, selector: "latest" } } };
    }
    this.progress(`Moving ${state.name} from ${plan.revision.label} to ${resolved.label}`);
    if (completePlan(state) !== null) {
      const live = this.liveTarget(store, plan);
      if (live.devSession === "running" || live.desktopSession === "running") {
        state = await this.stopLocked(
          store,
          state,
          ownerToken,
          deadline ?? Date.now() + DEFAULT_CONTROL_TIMEOUT_MS,
        );
      }
    }
    const moved: OwnedInstancePlan = { ...plan, revision: resolved };
    state = checkpoint(state, { phase: "preparing", step: "checkout", plan: moved });
    store.write(state);
    prepareCheckout(moved, ownerToken);
    assertRuntimeEnvContract(moved.checkoutPath);
    return { state, plan: moved };
  }

  /** Runtimes whose recorded process is alive on this instance's checkout. */
  private liveBorrowers(name: string): string[] {
    const root = join(this.home, "instances");
    if (!existsSync(root)) {
      return [];
    }
    const live: string[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === name) {
        continue;
      }
      const paths = instancePaths(this.home, entry.name);
      let state: InstanceState | null;
      try {
        state = new InstanceStore(paths).read();
      } catch {
        continue;
      }
      const plan = state === null ? null : statePlan(state);
      if (plan === null || plan.source !== "runtime" || plan.sourceInstance !== name) {
        continue;
      }
      if (runtimeIsRunning(readRuntimeRecord(paths.root))) {
        live.push(entry.name);
      }
    }
    return live.toSorted();
  }

  /**
   * What the instance actually looks like right now.
   *
   * bb-kit spawned the stack, so the recorded processes are the only sessions
   * it has; the rest of the target is what preparation leased.
   */
  private liveTarget(store: InstanceStore, plan: InstancePlan): LauncherTarget {
    if (plan.target === null) {
      throw new DevError(
        "instance_not_prepared",
        `Instance ${store.paths.root} has no leased ports yet.`,
        "Run bb-kit dev-instance start to resume preparation.",
      );
    }
    const record = readRuntimeRecord(store.paths.root);
    return {
      ...plan.target,
      devSession: runtimeIsRunning(record) ? "running" : "stopped",
      desktopSession: desktopIsRunning(record) ? "running" : "stopped",
    };
  }

  /**
   * Whether the instance is serving what was asked of it.
   *
   * The stack has to hold all three of its ports and answer on the app URL.
   * bb-kit spawned it, so it checks the sockets directly.
   */
  private async satisfied(target: LauncherTarget, desired: DesiredRuntime): Promise<boolean> {
    if (target.devSession !== "running") {
      return false;
    }
    if (desired === "desktop" && target.desktopSession !== "running") {
      return false;
    }
    const ports = await Promise.all([
      this.portProbe(target.appPort),
      this.portProbe(target.serverPort),
      this.portProbe(target.hostDaemonPort),
    ]);
    if (!ports.every(Boolean)) {
      return false;
    }
    return this.healthProbe(target.appUrl);
  }

  private async portsBusy(target: LauncherTarget): Promise<boolean> {
    const ports = await Promise.all([
      this.portProbe(target.appPort),
      this.portProbe(target.serverPort),
      this.portProbe(target.hostDaemonPort),
    ]);
    return ports.some(Boolean);
  }

  /** Whether the stack this instance recorded is alive on this target's ports. */
  private ownsRunningStack(store: InstanceStore, target: LauncherTarget): boolean {
    const record = readRuntimeRecord(store.paths.root);
    return runtimeIsRunning(record) && record?.ports.appPort === target.appPort;
  }

  /**
   * The target bb itself derives for an owned or attached checkout.
   *
   * Path-derived, exactly as bb's `resolveDevInstanceConfig` does it, so the
   * checkout's own `bb:dev` CLI reaches the stack bb-kit started without any
   * routing. Only the log directory is bb-kit's: an owned instance logs under
   * a name that includes its owner token, so a re-created instance never
   * appends to a stranger's log.
   */
  private ownTarget(
    plan: OwnedInstancePlan | Extract<InstancePlan, { source: "attached" }>,
    name: string,
    ownerToken: string,
  ): LauncherTarget {
    return checkoutTarget({
      checkoutPath: plan.checkoutPath,
      homeDir: this.homeDirectory(),
      logName:
        plan.source === "owned" ? `bb-kit-${sanitizeName(name)}-${ownerToken.slice(0, 8)}` : null,
      toolchain: readToolchain(plan.checkoutPath),
    });
  }

  /**
   * Lease a port triple and a data directory for a runtime.
   *
   * No checkout work happens here: the source instance already fetched,
   * installed, and built it. What a runtime does need is ports nothing else
   * holds, which it finds by probing rather than by hashing its path -- every
   * runtime on one checkout shares that path.
   */
  private async prepareRuntime(
    store: InstanceStore,
    state: InstanceState,
    initialPlan: RuntimeInstancePlan,
    ownerToken: string,
  ): Promise<InstanceState> {
    if (initialPlan.desiredRuntime === "desktop") {
      throw new DevError(
        "desktop_unsupported",
        `Runtime ${state.name} cannot run the desktop shell.`,
        "Start this instance with its own checkout, or drop --desktop.",
      );
    }
    if (!existsSync(join(initialPlan.checkoutPath, "package.json"))) {
      throw new DevError(
        "runtime_source_unavailable",
        `Source checkout ${initialPlan.checkoutPath} is gone.`,
        "Start the source instance again, or pass --owned to prepare a checkout of your own.",
      );
    }
    assertRuntimeEnvContract(initialPlan.checkoutPath);

    const record = readRuntimeRecord(store.paths.root);
    const startOffset = runtimePortOffset(state.name);
    // Ports this runtime already holds, so a restart keeps its URL rather than
    // drifting to another triple every time the first choice happens to be free.
    const held: RuntimePorts | null =
      record !== null && runtimeIsRunning(record)
        ? record.ports
        : initialPlan.target === null
          ? null
          : portsFor(initialPlan.target);
    for (let candidate = 0; candidate < MAX_RUNTIME_PORT_CANDIDATES; candidate += 1) {
      const ports: RuntimePorts =
        candidate === 0 && held !== null ? held : runtimePorts(startOffset + candidate);
      const target = runtimeTarget({
        name: state.name,
        checkoutPath: initialPlan.checkoutPath,
        homeDir: this.homeDirectory(),
        ports,
        toolchain: this.sourceToolchain(initialPlan.sourceInstance),
      });
      const leaseKey = leaseKeyFor(target);
      const complete = { ...initialPlan, target, leaseKey };
      const leaseClaimed = claimLease(this.home, leaseKey, ownerToken, state.name);
      const portsBusy = await Promise.all([
        this.portProbe(target.appPort),
        this.portProbe(target.serverPort),
        this.portProbe(target.hostDaemonPort),
      ]);
      const ownsRunningStack = runtimeIsRunning(record) && record?.ports.appPort === ports.appPort;
      if (leaseClaimed && (!portsBusy.some(Boolean) || ownsRunningStack)) {
        // Moving to another triple leaves the previous lease behind otherwise.
        if (initialPlan.leaseKey !== null && initialPlan.leaseKey !== leaseKey) {
          releaseLease(this.home, initialPlan.leaseKey, ownerToken);
        }
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
    }
    throw new DevError(
      "ports_busy",
      `Could not find a free port triple for runtime ${state.name}.`,
      "Stop some bb instances, then retry start.",
    );
  }

  /**
   * The owned instance whose checkout a runtime borrows.
   *
   * Only an instance that is prepared or running, sits on the same commit, and
   * has its dependencies installed can host one. Without `--from` this scans
   * for the first such sibling and returns null when there is none, so the
   * caller falls back to owning a checkout.
   */
  private findRuntimeSource(
    name: string,
    revision: ResolvedRevision,
    explicit?: string,
  ): { name: string; checkoutPath: string } | null {
    const root = join(this.home, "instances");
    if (!existsSync(root)) {
      return null;
    }
    if (explicit === name) {
      throw new DevError(
        "runtime_source_unavailable",
        `Instance ${name} cannot borrow its own checkout.`,
        "Name the instance that owns the checkout, or pass --owned.",
      );
    }
    const candidates =
      explicit === undefined
        ? readdirSync(root, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && entry.name !== name)
            .map((entry) => entry.name)
            .toSorted()
        : [explicit];
    for (const candidate of candidates) {
      const plan = this.readablePlan(candidate);
      if (
        plan === null ||
        plan.source !== "owned" ||
        plan.revision.commit !== revision.commit ||
        !existsSync(join(plan.checkoutPath, "node_modules"))
      ) {
        if (explicit !== undefined) {
          throw new DevError(
            "runtime_source_unavailable",
            `Instance ${explicit} cannot host a runtime at ${revision.commit.slice(0, 12)}.`,
            "Start that instance first, or pass --owned to prepare a checkout of your own.",
          );
        }
        continue;
      }
      return { name: candidate, checkoutPath: plan.checkoutPath };
    }
    return null;
  }

  private readablePlan(name: string): CompleteInstancePlan | null {
    try {
      const state = new InstanceStore(instancePaths(this.home, name)).read();
      if (state === null || (state.phase !== "prepared" && state.phase !== "running")) {
        return null;
      }
      return completePlan(state);
    } catch {
      return null;
    }
  }

  /** A runtime runs the source's checkout, so it reports the source's toolchain. */
  private sourceToolchain(sourceInstance: string): {
    branch: string | null;
    node: string | null;
    codex: string | null;
  } {
    const target = this.readablePlan(sourceInstance)?.target ?? null;
    return {
      branch: target?.branch ?? null,
      node: target?.node ?? null,
      codex: target?.codex ?? null,
    };
  }

  private newRuntimePlan(
    store: InstanceStore,
    name: string,
    revision: ResolvedRevision,
    desiredRuntime: DesiredRuntime,
    source: { name: string; checkoutPath: string },
  ): RuntimeInstancePlan {
    return {
      source: "runtime",
      sourceInstance: source.name,
      revision,
      checkoutPath: source.checkoutPath,
      desiredRuntime,
      shimPath: join(store.paths.bin, "bb"),
      leaseKey: null,
      target: null,
    };
  }

  private homeDirectory(): string {
    const configured = this.environment["HOME"];
    return configured === undefined || configured === "" ? homedir() : configured;
  }

  /**
   * Show the app to the user, and never let that decide whether start worked.
   *
   * The instance is up by the time this runs. Opening a browser is a courtesy
   * on top, so a spawn that throws is worth a line of progress and nothing
   * more. The opener's own async failures cannot reach here at all: it returns
   * void and is never awaited.
   */
  private openApp(url: string): void {
    try {
      this.opener(url);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.progress(`Could not open ${url}: ${detail}`);
    }
  }

  private newOwnedPlan(
    store: InstanceStore,
    name: string,
    revision: ResolvedRevision,
    desiredRuntime: DesiredRuntime,
    candidate: number,
  ): OwnedInstancePlan {
    const instanceRoot = realpathSync(store.paths.root);
    const checkoutPath = join(instanceRoot, candidate === 0 ? "checkout" : `checkout-${candidate}`);
    return {
      source: "owned",
      revision,
      checkoutPath,
      desiredRuntime,
      shimPath: join(store.paths.bin, "bb"),
      leaseKey: null,
      target: null,
    };
  }

  private newAttachedPlan(
    store: InstanceStore,
    checkoutPath: string,
    desiredRuntime: DesiredRuntime,
  ): InstancePlan {
    return {
      source: "attached",
      revision: null,
      checkoutPath,
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

  private async destroyPreRuntime(
    store: InstanceStore,
    state: InstanceState,
    ownerToken: string,
  ): Promise<void> {
    const plan = statePlan(state);
    if (plan !== null) {
      if (plan.target !== null || plan.leaseKey !== null) {
        throw new DevError(
          "cleanup_refused",
          `Instance ${state.name} has an incomplete external target.`,
          "Inspect state.json before retrying destroy.",
        );
      }
      if (plan.source === "owned") {
        await this.removeOwnedCheckout(store, plan, ownerToken);
      }
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

/**
 * Where destroy starts for each kind of instance.
 *
 * An owned instance made a checkout, a data directory, and logs. A runtime made
 * everything but the checkout, which belongs to the instance it borrowed. An
 * attached instance made none of it, and only holds a lease.
 */
function firstDestroyStep(source: InstancePlan["source"]): "checkout" | "external" | "lease" {
  if (source === "owned") return "checkout";
  return source === "runtime" ? "external" : "lease";
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

async function terminateStartedChild(child: ReturnType<typeof spawn>): Promise<void> {
  const exited = waitForChild(child);
  child.kill("SIGTERM");
  if (await settlesWithin(exited, 1_000)) return;
  child.kill("SIGKILL");
  await exited;
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function checkoutIndex(path: string): number {
  const match = /\/checkout-(\d+)$/.exec(path);
  return match?.[1] === undefined ? 0 : Number(match[1]);
}

function describeSource(plan: InstancePlan): string {
  if (plan.source === "owned") return `owned revision ${plan.revision.canonical}`;
  if (plan.source === "runtime") return `${plan.sourceInstance}'s checkout`;
  return `attached checkout ${plan.checkoutPath}`;
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
