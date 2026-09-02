import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DevError } from "./error.ts";

export const OFFICIAL_REPOSITORY = "https://github.com/get-bb/bb.git";
export const STATE_SCHEMA_VERSION = 1;

export type DesiredRuntime = "web" | "desktop";

export type RevisionRequest =
  | { kind: "latest" }
  | { kind: "local"; branch: string }
  | { kind: "origin"; branch: string }
  | { kind: "tag"; tag: string }
  | { kind: "commit"; commit: string };

export type ResolvedRevision = {
  selector: string;
  canonical: string;
  source: "official" | "selected-repository";
  repository: string;
  label: string;
  commit: string;
};

export type LauncherTarget = {
  repository: string;
  instanceId: string;
  dataDir: string;
  appUrl: string;
  serverUrl: string;
  hostDaemonUrl: string;
  desktopUserDataDir: string;
  devSession: "running" | "stopped";
  desktopSession: "running" | "stopped";
  devLog: string;
  desktopLog: string;
  launcherLog: string;
  appPort: number;
  serverPort: number;
  hostDaemonPort: number;
};

export type ProcessIdentity = {
  pid: number;
  started: string;
};

export type InstancePlan = {
  revision: ResolvedRevision;
  checkoutPath: string;
  launcherPath: string;
  launcherName: string;
  desiredRuntime: DesiredRuntime;
  shimPath: string;
  leaseKey: string | null;
  target: LauncherTarget | null;
};

type StateBase = {
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  name: string;
  ownerToken: string;
  createdAt: string;
  updatedAt: string;
};

export type ResolvingState = StateBase & {
  phase: "resolving";
  request: RevisionRequest;
  repository: string;
  resolverPath: string | null;
  desiredRuntime: DesiredRuntime;
};

export type PreparingCheckoutState = StateBase & {
  phase: "preparing";
  step: "checkout";
  plan: InstancePlan;
};

export type PreparingExternalState = StateBase & {
  phase: "preparing";
  step: "external";
  plan: InstancePlan & { target: LauncherTarget; leaseKey: string };
};

export type PreparedState = StateBase & {
  phase: "prepared";
  plan: InstancePlan & { target: LauncherTarget; leaseKey: string };
};

export type StartingState = StateBase & {
  phase: "starting";
  plan: InstancePlan & { target: LauncherTarget; leaseKey: string };
  child: ProcessIdentity;
};

export type RunningState = StateBase & {
  phase: "running";
  plan: InstancePlan & { target: LauncherTarget; leaseKey: string };
  observedAt: string;
};

export type StoppingState = StateBase & {
  phase: "stopping";
  plan: InstancePlan & { target: LauncherTarget; leaseKey: string };
  child: ProcessIdentity | null;
};

export type DestroyingState = StateBase & {
  phase: "destroying";
  plan: InstancePlan & { target: LauncherTarget; leaseKey: string };
  step: "runtime" | "checkout" | "external" | "lease";
};

export type FailedState = StateBase & {
  phase: "failed";
  code: string;
  message: string;
  retryFrom: "resolution" | "preparation" | "start" | "stop" | "destroy";
  resolving: Omit<ResolvingState, keyof StateBase | "phase"> | null;
  plan: InstancePlan | null;
};

export type InstanceState =
  | ResolvingState
  | PreparingCheckoutState
  | PreparingExternalState
  | PreparedState
  | StartingState
  | RunningState
  | StoppingState
  | DestroyingState
  | FailedState;

export type InstanceResult = {
  name: string;
  phase: string;
  revision: string | null;
  commit: string | null;
  desiredRuntime: DesiredRuntime | null;
  appUrl: string | null;
  running: boolean;
};

export type EnvironmentResult = {
  name: string;
  BB_CLI: string;
  BB_SERVER_URL: string;
  BB_HOST_DAEMON_PORT: string;
  BB_KIT_DEV_NAME: string;
};

export type InstancePaths = {
  home: string;
  root: string;
  state: string;
  owner: string;
  lock: string;
  execs: string;
  bin: string;
};

export function devHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env["BB_KIT_DEV_HOME"];
  if (explicit !== undefined && explicit !== "") {
    return resolve(expandHome(explicit));
  }
  const stateHome = env["XDG_STATE_HOME"];
  if (stateHome !== undefined && stateHome !== "") {
    return resolve(expandHome(stateHome), "bb-kit", "dev");
  }
  return join(homedir(), ".local", "state", "bb-kit", "dev");
}

export function instancePaths(home: string, name: string): InstancePaths {
  const root = join(home, "instances", name);
  return {
    home,
    root,
    state: join(root, "state.json"),
    owner: join(root, "owner.json"),
    lock: join(root, "lock"),
    execs: join(root, "execs"),
    bin: join(root, "bin"),
  };
}

export function expandHome(path: string): string {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

export function statePlan(state: InstanceState): InstancePlan | null {
  if (state.phase === "resolving") {
    return null;
  }
  return state.plan;
}

export function withUpdatedAt<T extends InstanceState>(state: T): T {
  return { ...state, updatedAt: new Date().toISOString() };
}

type StateBody =
  | Omit<ResolvingState, keyof StateBase>
  | Omit<PreparingCheckoutState, keyof StateBase>
  | Omit<PreparingExternalState, keyof StateBase>
  | Omit<PreparedState, keyof StateBase>
  | Omit<StartingState, keyof StateBase>
  | Omit<RunningState, keyof StateBase>
  | Omit<StoppingState, keyof StateBase>
  | Omit<DestroyingState, keyof StateBase>
  | Omit<FailedState, keyof StateBase>;

export function checkpoint(state: InstanceState, next: StateBody): InstanceState {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    name: state.name,
    ownerToken: state.ownerToken,
    createdAt: state.createdAt,
    updatedAt: new Date().toISOString(),
    ...next,
  } as InstanceState;
}

export function failedFromPlan(
  state: InstanceState,
  plan: InstancePlan,
  error: { code: string; message: string },
  retryFrom: "preparation" | "start" | "stop" | "destroy",
): InstanceState {
  return checkpoint(state, {
    phase: "failed",
    code: error.code,
    message: error.message,
    retryFrom,
    resolving: null,
    plan,
  });
}

export function recoveringResolution(
  state: InstanceState,
  desiredRuntime: DesiredRuntime,
): Omit<ResolvingState, keyof StateBase | "phase"> {
  if (state.phase === "resolving") {
    return {
      request: state.request,
      repository: state.repository,
      resolverPath: state.resolverPath,
      desiredRuntime,
    };
  }
  if (state.phase === "failed" && state.retryFrom === "resolution" && state.resolving !== null) {
    return { ...state.resolving, desiredRuntime };
  }
  throw new DevError(
    "invalid_state",
    `Instance ${state.name} has no resolved revision or recoverable request.`,
    "Inspect state.json before retrying start.",
  );
}

export function completePlan(
  state: InstanceState,
): (InstancePlan & { target: LauncherTarget; leaseKey: string }) | null {
  const plan = statePlan(state);
  if (plan === null || plan.target === null || plan.leaseKey === null) {
    return null;
  }
  return { ...plan, target: plan.target, leaseKey: plan.leaseKey };
}

export function requireCompletePlan(
  state: InstanceState,
): InstancePlan & { target: LauncherTarget; leaseKey: string } {
  const plan = completePlan(state);
  if (plan === null) {
    throw new DevError(
      "instance_not_prepared",
      `Instance ${state.name} has not completed preparation.`,
      "Run bb-kit dev-instance start to resume preparation.",
    );
  }
  return plan;
}

export function requireTargetPlan(
  plan: InstancePlan,
): InstancePlan & { target: LauncherTarget; leaseKey: string } {
  if (plan.target === null || plan.leaseKey === null) {
    throw new DevError(
      "instance_not_prepared",
      "The instance plan has no launcher target.",
      "Retry start to resume preparation.",
    );
  }
  return { ...plan, target: plan.target, leaseKey: plan.leaseKey };
}

export function resultFromState(state: InstanceState, running: boolean): InstanceResult {
  const plan = statePlan(state);
  return {
    name: state.name,
    phase: state.phase,
    revision: plan?.revision.canonical ?? null,
    commit: plan?.revision.commit ?? null,
    desiredRuntime:
      plan?.desiredRuntime ?? (state.phase === "resolving" ? state.desiredRuntime : null),
    appUrl: plan?.target?.appUrl ?? null,
    running,
  };
}

export function emptyResult(name: string): InstanceResult {
  return {
    name,
    phase: "absent",
    revision: null,
    commit: null,
    desiredRuntime: null,
    appUrl: null,
    running: false,
  };
}

export function existingRuntime(state: InstanceState | null): DesiredRuntime | null {
  if (state === null) {
    return null;
  }
  if (state.phase === "resolving") {
    return state.desiredRuntime;
  }
  if (state.phase === "failed" && state.plan === null) {
    return state.resolving?.desiredRuntime ?? null;
  }
  return state.plan?.desiredRuntime ?? null;
}

export function requestLabel(request: RevisionRequest): string {
  if (request.kind === "latest") {
    return "latest";
  }
  if (request.kind === "local" || request.kind === "origin") {
    return `${request.kind}:${request.branch}`;
  }
  if (request.kind === "tag") {
    return `tag:${request.tag}`;
  }
  return `commit:${request.commit}`;
}
