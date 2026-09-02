import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DevError } from "./error.ts";
import {
  STATE_SCHEMA_VERSION,
  type InstancePaths,
  type InstancePlan,
  type InstanceState,
  type LauncherTarget,
  type ProcessIdentity,
  type ResolvedRevision,
  type RevisionRequest,
} from "./model.ts";
import { processIdentity, processMatches } from "./process.ts";

type OwnerRecord = {
  ownerToken: string;
  name: string;
  createdAt: string;
};

type LockRecord = {
  ownerToken: string;
  manager: ProcessIdentity;
  createdAt: string;
};

type ExecRecordBase = {
  ownerToken: string;
  identity: ProcessIdentity;
  createdAt: string;
};

type UnkeyedExecRecord = ExecRecordBase & {
  kind: "unkeyed";
};

type SingletonExecRecord = ExecRecordBase & {
  kind: "singleton";
  schemaVersion: 1;
  recordToken: string;
  cwd: string;
  key: string;
  commandDigest: string;
};

type ExecRecord = UnkeyedExecRecord | SingletonExecRecord;

export type SingletonExecSpec = {
  cwd: string;
  key: string;
  commandDigest: string;
};

export type SingletonExecHandle = {
  path: string;
  ownerToken: string;
  recordToken: string;
};

export type SingletonExecLookup =
  | { kind: "vacant" }
  | { kind: "reused" }
  | { kind: "legacy-conflict"; identities: readonly ProcessIdentity[] };

export const OWNER_MARKER = ".bb-kit-owner.json";

export class InstanceStore {
  readonly paths: InstancePaths;

  constructor(paths: InstancePaths) {
    this.paths = paths;
  }

  claim(name: string): OwnerRecord {
    const owner = { ownerToken: randomUUID(), name, createdAt: new Date().toISOString() };
    if (claimDirectoryAtomically(this.paths.root, "owner.json", owner)) {
      return owner;
    }
    const existing = parseOwner(readJson(this.paths.owner), this.paths.owner);
    if (existing.name !== name) {
      throw new DevError(
        "owner_mismatch",
        `Instance root ${this.paths.root} belongs to ${existing.name}.`,
        "Choose another instance name.",
      );
    }
    return existing;
  }

  read(): InstanceState | null {
    if (!existsSync(this.paths.state)) {
      return null;
    }
    return parseState(readJson(this.paths.state));
  }

  write(state: InstanceState): void {
    const owner = parseOwner(readJson(this.paths.owner), this.paths.owner);
    if (owner.ownerToken !== state.ownerToken || owner.name !== state.name) {
      throw new DevError(
        "owner_mismatch",
        `Refusing to write state for instance ${state.name}.`,
        "Inspect owner.json and choose another name if another manager owns it.",
      );
    }
    atomicWriteJson(this.paths.state, state);
  }

  async lock(ownerToken: string, timeoutMs: number): Promise<() => void> {
    const deadline = Date.now() + timeoutMs;
    const manager = processIdentity(process.pid);
    if (manager === null) {
      throw new DevError(
        "process_identity_unavailable",
        "Could not record the manager process identity.",
        "Retry from a normal local shell.",
      );
    }
    while (true) {
      const record: LockRecord = {
        ownerToken,
        manager,
        createdAt: new Date().toISOString(),
      };
      if (claimDirectoryAtomically(this.paths.lock, "owner.json", record)) {
        return () => this.releaseLock(record);
      }
      const reclaimable = this.lockIsReclaimable(ownerToken);
      if (reclaimable) {
        rmSync(this.paths.lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new DevError(
          "instance_busy",
          `Instance ${this.paths.root.split("/").at(-1) ?? "unknown"} is busy.`,
          "Wait for the active operation to finish, then retry.",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, deadline - Date.now())));
    }
  }

  activeExecs(ownerToken: string): readonly ProcessIdentity[] {
    if (!existsSync(this.paths.execs)) {
      return [];
    }
    const active: ProcessIdentity[] = [];
    for (const file of readdirSync(this.paths.execs)) {
      if (!file.endsWith(".json")) {
        continue;
      }
      const path = join(this.paths.execs, file);
      try {
        const record = readExec(path);
        assertExecOwner(path, record, ownerToken);
        if (record.kind === "singleton") assertSingletonSlot(path, record);
        if (processMatches(record.identity)) {
          active.push(record.identity);
        } else {
          unlinkSync(path);
        }
      } catch (error) {
        if (error instanceof DevError) {
          throw error;
        }
        throw new DevError(
          "ambiguous_exec",
          `Cannot validate exec record ${path}.`,
          "Inspect the record before stopping or destroying the instance.",
        );
      }
    }
    return active;
  }

  addExec(ownerToken: string, identity: ProcessIdentity): string {
    mkdirSync(this.paths.execs, { recursive: true });
    const path = join(this.paths.execs, `${randomUUID()}.json`);
    writeExclusiveJson(path, { ownerToken, identity, createdAt: new Date().toISOString() });
    return path;
  }

  reconcileSingleton(ownerToken: string, expected: SingletonExecSpec): SingletonExecLookup {
    const path = singletonExecPath(this.paths.execs, expected.cwd, expected.key);
    if (existsSync(path)) {
      const record = readExec(path);
      assertExecOwner(path, record, ownerToken);
      if (record.kind !== "singleton") {
        throw new DevError(
          "singleton_record_mismatch",
          `Singleton slot ${path} contains an unkeyed exec record.`,
          "Inspect the record before retrying the singleton command.",
        );
      }
      assertSingletonMatch(path, record, expected);
      if (processMatches(record.identity)) {
        return { kind: "reused" };
      }
      unlinkSync(path);
    }

    const legacy: ProcessIdentity[] = [];
    if (!existsSync(this.paths.execs)) {
      return { kind: "vacant" };
    }
    for (const file of readdirSync(this.paths.execs)) {
      if (!file.endsWith(".json")) continue;
      const candidatePath = join(this.paths.execs, file);
      if (candidatePath === path) continue;
      const record = readExec(candidatePath);
      assertExecOwner(candidatePath, record, ownerToken);
      if (record.kind === "singleton") assertSingletonSlot(candidatePath, record);
      if (!processMatches(record.identity)) {
        unlinkSync(candidatePath);
      } else if (record.kind === "unkeyed") {
        legacy.push(record.identity);
      }
    }
    return legacy.length === 0
      ? { kind: "vacant" }
      : { kind: "legacy-conflict", identities: legacy };
  }

  addSingleton(
    ownerToken: string,
    spec: SingletonExecSpec,
    identity: ProcessIdentity,
  ): SingletonExecHandle {
    mkdirSync(this.paths.execs, { recursive: true });
    const path = singletonExecPath(this.paths.execs, spec.cwd, spec.key);
    const recordToken = randomUUID();
    try {
      writeExclusiveJson(path, {
        kind: "singleton",
        schemaVersion: 1,
        ownerToken,
        recordToken,
        cwd: spec.cwd,
        key: spec.key,
        commandDigest: spec.commandDigest,
        identity,
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      if (isAlreadyExists(error)) {
        throw new DevError(
          "singleton_slot_busy",
          `Singleton slot ${path} appeared while the instance lock was held.`,
          "Inspect the instance lock and singleton record before retrying.",
        );
      }
      throw error;
    }
    return { path, ownerToken, recordToken };
  }

  removeExec(path: string): void {
    rmSync(path, { force: true });
  }

  removeSingleton(handle: SingletonExecHandle): void {
    if (!existsSync(handle.path)) return;
    const record = readExec(handle.path);
    assertExecOwner(handle.path, record, handle.ownerToken);
    if (record.kind !== "singleton") {
      throw new DevError(
        "singleton_record_mismatch",
        `Singleton slot ${handle.path} contains an unkeyed exec record.`,
        "Inspect the record before retrying cleanup.",
      );
    }
    if (record.recordToken === handle.recordToken) unlinkSync(handle.path);
  }

  readOwner(): OwnerRecord {
    return parseOwner(readJson(this.paths.owner), this.paths.owner);
  }

  private lockIsReclaimable(ownerToken: string): boolean {
    const path = join(this.paths.lock, "owner.json");
    let lock: LockRecord;
    try {
      lock = parseLock(readJson(path));
    } catch {
      return false;
    }
    if (lock.ownerToken !== ownerToken || processMatches(lock.manager)) {
      return false;
    }
    const state = this.read();
    if (
      state !== null &&
      (state.phase === "starting" || state.phase === "stopping") &&
      state.child !== null &&
      processMatches(state.child)
    ) {
      return false;
    }
    return true;
  }

  private releaseLock(expected: LockRecord): void {
    const path = join(this.paths.lock, "owner.json");
    try {
      const actual = parseLock(readJson(path));
      if (
        actual.ownerToken === expected.ownerToken &&
        actual.manager.pid === expected.manager.pid &&
        actual.manager.started === expected.manager.started
      ) {
        rmSync(this.paths.lock, { recursive: true, force: true });
      }
    } catch {
      return;
    }
  }
}

export function claimDirectoryAtomically(
  target: string,
  markerName: string,
  marker: unknown,
): boolean {
  const parent = dirname(target);
  mkdirSync(parent, { recursive: true });
  const temporary = join(parent, `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  mkdirSync(temporary);
  try {
    writeExclusiveJson(join(temporary, markerName), marker);
    try {
      renameSync(temporary, target);
      return true;
    } catch (error) {
      if (existsSync(target)) {
        return false;
      }
      throw error;
    }
  } finally {
    if (existsSync(temporary)) {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
}

export function claimLease(home: string, key: string, ownerToken: string, name: string): boolean {
  const root = join(home, "leases", key);
  if (
    claimDirectoryAtomically(root, "owner.json", {
      ownerToken,
      purpose: "lease",
      createdAt: new Date().toISOString(),
      name,
    })
  ) {
    return true;
  }
  try {
    return readOwnerToken(join(root, "owner.json")) === ownerToken;
  } catch {
    return false;
  }
}

export function assertLeaseOwned(home: string, key: string, ownerToken: string): void {
  const path = join(home, "leases", key, "owner.json");
  if (!existsSync(path) || readOwnerToken(path) !== ownerToken) {
    throw new DevError(
      "lease_mismatch",
      `Port lease ${key} is not owned by this instance.`,
      "Do not stop or destroy the target. Inspect the lease owner first.",
    );
  }
}

export function releaseLease(home: string, key: string, ownerToken: string): void {
  const root = join(home, "leases", key);
  if (!existsSync(root)) {
    return;
  }
  if (readOwnerToken(join(root, "owner.json")) !== ownerToken) {
    throw new DevError(
      "lease_mismatch",
      `Refusing to remove lease ${key} owned by another instance.`,
      "Inspect the lease owner before retrying destroy.",
    );
  }
  rmSync(root, { recursive: true });
}

export function ensureOwnedDirectory(path: string, ownerToken: string, purpose: string): void {
  if (
    claimDirectoryAtomically(path, OWNER_MARKER, {
      ownerToken,
      purpose,
      createdAt: new Date().toISOString(),
    })
  ) {
    return;
  }
  const marker = join(path, OWNER_MARKER);
  if (existsSync(marker)) {
    assertOwnerMarker(marker, ownerToken);
    return;
  }
  if (readdirSync(path).length !== 0) {
    throw new DevError(
      "external_path_busy",
      `External path ${path} exists without this instance owner marker.`,
      "Choose another instance name or inspect the path before retrying.",
    );
  }
  writeOwnerMarker(marker, ownerToken, purpose);
}

export function writeOwnerMarker(
  path: string,
  ownerToken: string,
  purpose: string,
  extra: Record<string, unknown> = {},
): void {
  writeFileSync(
    path,
    `${JSON.stringify({ ownerToken, purpose, createdAt: new Date().toISOString(), ...extra }, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
}

export function assertOwnerMarker(path: string, ownerToken: string): void {
  if (readOwnerToken(path) !== ownerToken) {
    throw new DevError(
      "owner_mismatch",
      `Path ${dirname(path)} belongs to another owner.`,
      "Do not modify or delete the path.",
    );
  }
}

export function readOwnerToken(path: string): string {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    value = null;
  }
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>)["ownerToken"] === "string"
  ) {
    return String((value as Record<string, unknown>)["ownerToken"]);
  }
  throw new DevError(
    "owner_mismatch",
    `Owner marker ${path} is missing or malformed.`,
    "Do not modify or delete the path until ownership is known.",
  );
}

export function safeRemoveOwned(
  path: string,
  expectedRoot: string,
  recordedPath: string,
  ownerToken: string,
  markerName = OWNER_MARKER,
): void {
  if (!existsSync(path)) {
    return;
  }
  if (resolve(path) !== resolve(recordedPath)) {
    throw new DevError(
      "cleanup_refused",
      `Cleanup path ${path} does not equal the recorded path ${recordedPath}.`,
      "Inspect state.json before retrying destroy.",
    );
  }
  const actual = realpathSync(path);
  const root = realpathSync(expectedRoot);
  if (actual !== root && !actual.startsWith(`${root}${sep}`)) {
    throw new DevError(
      "cleanup_refused",
      `Cleanup path ${actual} escapes ${root}.`,
      "Inspect symlinks and state.json before retrying destroy.",
    );
  }
  assertOwnerMarker(join(actual, markerName), ownerToken);
  rmSync(actual, { recursive: true });
}

export function parseState(value: unknown): InstanceState {
  const object = record(value, "state");
  const storedSchemaVersion = integerField(object, "schemaVersion");
  if (storedSchemaVersion !== 1 && storedSchemaVersion !== STATE_SCHEMA_VERSION) {
    invalid("schemaVersion");
  }
  const legacy = storedSchemaVersion === 1;
  const base = {
    schemaVersion: STATE_SCHEMA_VERSION,
    name: stringField(object, "name"),
    ownerToken: stringField(object, "ownerToken"),
    createdAt: stringField(object, "createdAt"),
    updatedAt: stringField(object, "updatedAt"),
  } as const;
  const phase = stringField(object, "phase");
  if (phase === "resolving") {
    return {
      ...base,
      phase,
      request: parseRequest(object["request"]),
      repository: stringField(object, "repository"),
      resolverPath: nullableString(object["resolverPath"], "resolverPath"),
      desiredRuntime: runtimeField(object, "desiredRuntime"),
    };
  }
  if (phase === "failed") {
    const retryFrom = stringField(object, "retryFrom");
    if (!["resolution", "preparation", "start", "stop", "destroy"].includes(retryFrom)) {
      invalid("retryFrom");
    }
    return {
      ...base,
      phase,
      code: stringField(object, "code"),
      message: stringField(object, "message"),
      retryFrom: retryFrom as "resolution" | "preparation" | "start" | "stop" | "destroy",
      resolving: object["resolving"] === null ? null : parseResolvingPayload(object["resolving"]),
      plan: object["plan"] === null ? null : parsePlan(object["plan"], legacy),
    };
  }
  const plan = parsePlan(object["plan"], legacy);
  if (phase === "preparing") {
    const step = stringField(object, "step");
    if (step === "checkout") {
      return { ...base, phase, step, plan };
    }
    if (step === "external" && plan.target !== null && plan.leaseKey !== null) {
      return {
        ...base,
        phase,
        step,
        plan: { ...plan, target: plan.target, leaseKey: plan.leaseKey },
      };
    }
    invalid("preparing step");
  }
  if (plan.target === null || plan.leaseKey === null) {
    invalid(`${phase} plan target`);
  }
  const completePlan = { ...plan, target: plan.target, leaseKey: plan.leaseKey };
  if (phase === "prepared") {
    return { ...base, phase, plan: completePlan };
  }
  if (phase === "starting") {
    return { ...base, phase, plan: completePlan, child: parseIdentity(object["child"]) };
  }
  if (phase === "running") {
    return { ...base, phase, plan: completePlan, observedAt: stringField(object, "observedAt") };
  }
  if (phase === "stopping") {
    return {
      ...base,
      phase,
      plan: completePlan,
      child: object["child"] === null ? null : parseIdentity(object["child"]),
    };
  }
  if (phase === "destroying") {
    const step = stringField(object, "step");
    if (!["runtime", "checkout", "external", "lease"].includes(step)) {
      invalid("destroy step");
    }
    return {
      ...base,
      phase,
      plan: completePlan,
      step: step as "runtime" | "checkout" | "external" | "lease",
    };
  }
  invalid("phase");
}

function parsePlan(value: unknown, legacy: boolean): InstancePlan {
  const object = record(value, "plan");
  const common = {
    checkoutPath: stringField(object, "checkoutPath"),
    launcherPath: stringField(object, "launcherPath"),
    desiredRuntime: runtimeField(object, "desiredRuntime"),
    shimPath: stringField(object, "shimPath"),
    leaseKey: nullableString(object["leaseKey"], "leaseKey"),
    target: object["target"] === null ? null : parseTarget(object["target"]),
  };
  if (legacy) {
    return {
      ...common,
      source: "owned",
      revision: parseRevision(object["revision"]),
      launcherName: stringField(object, "launcherName"),
    };
  }
  const source = stringField(object, "source");
  if (source === "owned") {
    return {
      ...common,
      source,
      revision: parseRevision(object["revision"]),
      launcherName: stringField(object, "launcherName"),
    };
  }
  if (source === "attached") {
    if (object["revision"] !== null || object["launcherName"] !== null) {
      invalid("attached plan source");
    }
    return { ...common, source, revision: null, launcherName: null };
  }
  invalid("plan source");
}

function parseRevision(value: unknown): ResolvedRevision {
  const object = record(value, "revision");
  const source = stringField(object, "source");
  if (source !== "official" && source !== "selected-repository") {
    invalid("revision source");
  }
  const commit = stringField(object, "commit");
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    invalid("revision commit");
  }
  return {
    selector: stringField(object, "selector"),
    canonical: stringField(object, "canonical"),
    source,
    repository: stringField(object, "repository"),
    label: stringField(object, "label"),
    commit,
  };
}

function parseTarget(value: unknown): LauncherTarget {
  const object = record(value, "launcher target");
  const devSession = stringField(object, "devSession");
  const desktopSession = stringField(object, "desktopSession");
  if (!(["running", "stopped"] as const).includes(devSession as "running" | "stopped")) {
    invalid("devSession");
  }
  if (!(["running", "stopped"] as const).includes(desktopSession as "running" | "stopped")) {
    invalid("desktopSession");
  }
  return {
    repository: stringField(object, "repository"),
    branch: optionalStringField(object, "branch"),
    node: optionalStringField(object, "node"),
    codex: optionalStringField(object, "codex"),
    instanceId: stringField(object, "instanceId"),
    dataDir: stringField(object, "dataDir"),
    appUrl: stringField(object, "appUrl"),
    serverUrl: stringField(object, "serverUrl"),
    hostDaemonUrl: stringField(object, "hostDaemonUrl"),
    desktopUserDataDir: stringField(object, "desktopUserDataDir"),
    devSession: devSession as "running" | "stopped",
    desktopSession: desktopSession as "running" | "stopped",
    devLog: stringField(object, "devLog"),
    desktopLog: stringField(object, "desktopLog"),
    launcherLog: stringField(object, "launcherLog"),
    appPort: integerField(object, "appPort"),
    serverPort: integerField(object, "serverPort"),
    hostDaemonPort: integerField(object, "hostDaemonPort"),
  };
}

function parseRequest(value: unknown): RevisionRequest {
  const object = record(value, "revision request");
  const kind = stringField(object, "kind");
  if (kind === "latest") {
    return { kind };
  }
  if (kind === "local" || kind === "origin") {
    return { kind, branch: stringField(object, "branch") };
  }
  if (kind === "tag") {
    return { kind, tag: stringField(object, "tag") };
  }
  if (kind === "commit") {
    return { kind, commit: stringField(object, "commit") };
  }
  invalid("revision request kind");
}

function parseResolvingPayload(value: unknown): {
  request: RevisionRequest;
  repository: string;
  resolverPath: string | null;
  desiredRuntime: "web" | "desktop";
} {
  const object = record(value, "resolving payload");
  return {
    request: parseRequest(object["request"]),
    repository: stringField(object, "repository"),
    resolverPath: nullableString(object["resolverPath"], "resolverPath"),
    desiredRuntime: runtimeField(object, "desiredRuntime"),
  };
}

function parseOwner(value: unknown, path: string): OwnerRecord {
  try {
    const object = record(value, "owner");
    return {
      ownerToken: stringField(object, "ownerToken"),
      name: stringField(object, "name"),
      createdAt: stringField(object, "createdAt"),
    };
  } catch {
    throw new DevError(
      "invalid_owner",
      `Owner record ${path} is malformed.`,
      "Inspect the instance root. Do not delete it until ownership is known.",
    );
  }
}

function parseLock(value: unknown): LockRecord {
  const object = record(value, "lock");
  return {
    ownerToken: stringField(object, "ownerToken"),
    manager: parseIdentity(object["manager"]),
    createdAt: stringField(object, "createdAt"),
  };
}

function parseExec(value: unknown): ExecRecord {
  const object = record(value, "exec");
  const base = {
    ownerToken: stringField(object, "ownerToken"),
    identity: parseIdentity(object["identity"]),
    createdAt: stringField(object, "createdAt"),
  };
  if (object["kind"] === undefined) {
    return { kind: "unkeyed", ...base };
  }
  const kind = stringField(object, "kind");
  if (kind === "singleton" && object["schemaVersion"] === 1) {
    return {
      kind,
      schemaVersion: 1,
      ...base,
      recordToken: stringField(object, "recordToken"),
      cwd: stringField(object, "cwd"),
      key: stringField(object, "key"),
      commandDigest: stringField(object, "commandDigest"),
    };
  }
  invalid("exec kind");
}

function readExec(path: string): ExecRecord {
  try {
    return parseExec(readJson(path));
  } catch (error) {
    if (error instanceof DevError && error.code === "owner_mismatch") throw error;
    throw new DevError(
      "ambiguous_exec",
      `Cannot validate exec record ${path}.`,
      "Inspect the record before retrying the lifecycle command.",
    );
  }
}

function assertExecOwner(path: string, record: ExecRecord, ownerToken: string): void {
  if (record.ownerToken !== ownerToken) {
    throw new DevError(
      "owner_mismatch",
      `Exec record ${path} has another owner.`,
      "Wait for the owner to remove the record.",
    );
  }
}

function assertSingletonMatch(
  path: string,
  record: SingletonExecRecord,
  expected: SingletonExecSpec,
): void {
  if (record.cwd !== expected.cwd || record.key !== expected.key) {
    throw new DevError(
      "singleton_key_mismatch",
      `Singleton slot ${path} contains another full key.`,
      "Inspect the singleton record before retrying.",
    );
  }
  if (record.commandDigest !== expected.commandDigest) {
    throw new DevError(
      "singleton_command_mismatch",
      `Singleton key ${record.key} already identifies another command.`,
      "Stop the existing singleton command or choose another key.",
    );
  }
}

function assertSingletonSlot(path: string, record: SingletonExecRecord): void {
  const expected = singletonExecPath(dirname(path), record.cwd, record.key);
  if (path !== expected) {
    throw new DevError(
      "singleton_key_mismatch",
      `Singleton record ${path} does not match its full key.`,
      "Inspect the singleton record before retrying.",
    );
  }
}

function singletonExecPath(execs: string, cwd: string, key: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([cwd, key]))
    .digest("hex");
  return join(execs, `singleton-${digest}.json`);
}

function isAlreadyExists(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "EEXIST"
  );
}

function parseIdentity(value: unknown): ProcessIdentity {
  const object = record(value, "process identity");
  return { pid: integerField(object, "pid"), started: stringField(object, "started") };
}

function runtimeField(object: Record<string, unknown>, key: string): "web" | "desktop" {
  const value = stringField(object, key);
  if (value !== "web" && value !== "desktop") {
    invalid(key);
  }
  return value;
}

function nullableString(value: unknown, key: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || value === "") {
    invalid(key);
  }
  return value;
}

function optionalStringField(object: Record<string, unknown>, key: string): string | null {
  const value = object[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || value === "") {
    invalid(key);
  }
  return value;
}

function record(value: unknown, key: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(key);
  }
  return value as Record<string, unknown>;
}

function stringField(object: Record<string, unknown>, key: string): string {
  const value = object[key];
  if (typeof value !== "string" || value === "") {
    invalid(key);
  }
  return value;
}

function integerField(object: Record<string, unknown>, key: string): number {
  const value = object[key];
  if (!Number.isInteger(value) || Number(value) < 0) {
    invalid(key);
  }
  return Number(value);
}

function invalid(key: string): never {
  throw new DevError(
    "invalid_state",
    `Stored instance ${key} is malformed.`,
    "Inspect state.json before retrying a lifecycle command.",
  );
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DevError(
      "invalid_state",
      `Could not read ${path}: ${message}`,
      "Inspect the file before retrying.",
    );
  }
}

function writeExclusiveJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
}
