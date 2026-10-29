import type { BbPluginApi, JsonValue } from "@get-bb/plugin-sdk";
import type {
  PluginMachineProviderCreateContext,
  PluginMachineProviderProgress,
} from "@get-bb/plugin-sdk/machine-provider";
import {
  createFakePluginHost,
  makeHostResponse,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, test, vi } from "vitest";
import { PROVIDER_ID, type SandboxState } from "../shared/constants.ts";
import { readMachineResource } from "../shared/schema.ts";
import type { BoatClient, BoatCreateRequest, BoatSandbox } from "./lib/boat-api.ts";
import { BoatApiError } from "./lib/boat-api.ts";
import { IDLE_SWEEP_SCHEDULE } from "./lib/idle.ts";
import { createBoatSandboxPlugin } from "./server.ts";

const PLUGIN_ID = "boat-sandbox";
const HOST_ID = "host_boat";
const KEY = "thread-key-1";
const SETTINGS = { apiKey: "boat_test" };
const report: PluginMachineProviderProgress = { step() {}, log() {} };
type Host = Awaited<ReturnType<BbPluginApi["sdk"]["hosts"]["list"]>>[number];

interface FakeSandboxState {
  id: string;
  state: SandboxState;
  type: "small" | "default" | "large" | "xlarge";
  labels: Record<string, string>;
  archiveAfter: string | null;
  dataExpiredAt: string | null;
  deleted: boolean;
  /** Boat deletes after its 202: listings still show the sandbox for this many polls. */
  deletingPolls: number;
}

/** An in-memory Boat: sandboxes settle one state per poll so the waits in the plugin are exercised. */
function createFakeBoat(identity = "account-a") {
  const sandboxes: FakeSandboxState[] = [];
  const creates: BoatCreateRequest[] = [];
  const stops: string[] = [];
  const resumes: { id: string; ttlSeconds: number | null }[] = [];
  const extends_: { id: string; ttlSeconds: number }[] = [];
  const deletes: string[] = [];
  let nextId = 0;
  let failNextCreate: BoatApiError | null = null;
  const view = (state: FakeSandboxState): BoatSandbox => ({
    id: state.id,
    name: "bb test",
    state: state.state,
    error: state.state === "error" ? "machine lost" : null,
    type: state.type,
    archiveAfter: state.archiveAfter,
    hydrated: true,
    dataExpiredAt: state.dataExpiredAt,
    stop: null,
  });
  const live = () => sandboxes.filter((s) => !s.deleted);
  const client: BoatClient = {
    async account() {
      return { identity, login: "scott", activeSandboxes: 1, maxActiveSandboxes: 100 };
    },
    async machineTypes() {
      return [
        { type: "small", available: true, reason: null },
        { type: "default", available: true, reason: null },
        { type: "large", available: true, reason: null },
        { type: "xlarge", available: false, reason: "needs the $100 plan" },
      ];
    },
    async savedSnapshots() {
      return ["web-stack"];
    },
    async create(request) {
      if (failNextCreate !== null) {
        const failure = failNextCreate;
        failNextCreate = null;
        throw failure;
      }
      creates.push(request);
      nextId += 1;
      const state: FakeSandboxState = {
        id: `bx_${String(nextId).padStart(8, "0")}`,
        state: "provisioning",
        type: request.type,
        labels: { bbMachineKey: request.key },
        archiveAfter:
          request.ttlSeconds === null ? null : new Date(request.ttlSeconds * 1000).toISOString(),
        dataExpiredAt: null,
        deleted: false,
        deletingPolls: 0,
      };
      sandboxes.push(state);
      return view(state);
    },
    async get(id) {
      const state = live().find((s) => s.id === id);
      if (state === undefined) return null;
      const snapshot = view(state);
      // Advance one step per observation.
      if (state.state === "provisioning") state.state = "ready";
      else if (state.state === "archiving") state.state = "archived";
      return snapshot;
    },
    async listByKey(key) {
      const listed = live().filter((s) => s.labels.bbMachineKey === key);
      for (const state of listed) {
        if (state.deletingPolls > 0) {
          state.deletingPolls -= 1;
          if (state.deletingPolls === 0) state.deleted = true;
        }
      }
      return listed.map(view);
    },
    async stop(id) {
      stops.push(id);
      const state = live().find((s) => s.id === id);
      if (state === undefined) throw new BoatApiError(404, "not_found", "gone", null);
      state.state = "archiving";
    },
    async resume(id, ttlSeconds) {
      resumes.push({ id, ttlSeconds });
      const state = live().find((s) => s.id === id);
      if (state === undefined) throw new BoatApiError(404, "not_found", "gone", null);
      if (state.state === "ready")
        throw new BoatApiError(409, "sandbox_running", "already running", null);
      state.state = "provisioning";
    },
    async extend(id, ttlSeconds) {
      extends_.push({ id, ttlSeconds });
      const state = live().find((s) => s.id === id);
      if (state) state.archiveAfter = new Date(ttlSeconds * 1000).toISOString();
    },
    async delete(id) {
      const state = sandboxes.find((s) => s.id === id);
      if (state === undefined || state.deleted || state.deletingPolls > 0) return;
      deletes.push(id);
      state.deletingPolls = 2;
    },
    async startCommand() {
      return 1;
    },
    async commandStatus() {
      return { status: "exited", running: false, exitCode: 0 };
    },
    async *attach() {
      yield { type: "exit", status: "exited", exitCode: 0, signal: null };
    },
    async stopCommand() {},
    async writeFile() {},
    async deleteFile() {},
  };
  return {
    client,
    sandboxes,
    creates,
    stops,
    resumes,
    extends: extends_,
    deletes,
    failNextCreate(error: BoatApiError) {
      failNextCreate = error;
    },
    /** Boat's background deletion has finished: the sandboxes stop being listed. */
    finishDeletes() {
      for (const state of sandboxes) {
        if (state.deletingPolls > 0) {
          state.deletingPolls = 0;
          state.deleted = true;
        }
      }
    },
  };
}

function host(overrides: Partial<Host> = {}): Host {
  return makeHostResponse({
    id: HOST_ID,
    machineProviderId: PROVIDER_ID,
    status: "connected",
    lifecycle: {
      phase: "active",
      suspendedAt: null,
      message: null,
      pendingLog: "",
      teardown: null,
    },
    ...overrides,
  });
}

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((entry) => entry.harness.lifecycle.dispose()));
});

async function setup(
  settings: Record<string, string | number> = SETTINGS,
  options: { identity?: string } = {},
) {
  const boat = createFakeBoat(options.identity);
  let now = 1_000_000;
  const resources = new Map<string, JsonValue>();
  const hostList: Host[] = [];
  const suspended: string[] = [];
  let occupyingThreads = 0;
  let coreBusy = false;
  let randomIds = 0;
  const fake = createFakePluginHost({
    pluginId: PLUGIN_ID,
    settings,
    machineResource: async (hostId) => resources.get(hostId) ?? null,
    sdk: {
      hosts: {
        list: async () => hostList,
        get: async ({ hostId }) => {
          const found = hostList.find((entry) => entry.id === hostId);
          if (!found) throw new Error("no such host");
          return found;
        },
        experimental_suspend: async ({ hostId }) => {
          if (coreBusy) throw Object.assign(new Error("machine busy"), { code: "machine_busy" });
          suspended.push(hostId);
          return host({
            id: hostId,
            lifecycle: {
              phase: "suspending",
              suspendedAt: null,
              message: null,
              pendingLog: "",
              teardown: null,
            },
          });
        },
      },
      environments: { get: async () => ({ id: "env_1", hostId: HOST_ID }) },
      threads: {
        count: async (args) => ({ total: args?.status === "active" ? occupyingThreads : 0 }),
      },
    },
  });
  hosts.push(fake);
  const bootstrap = vi.fn(async (request: { key: string; executor: { exec: Function } }) => {
    await request.executor.exec({
      command: ["bash", "-c", "install"],
      stdin: "bundle",
      timeoutMs: 60_000,
      signal: new AbortController().signal,
      onOutput: () => {},
    });
    return { hostId: HOST_ID };
  });
  Object.assign(fake.bb.experimental_machines, { bootstrap });
  await createBoatSandboxPlugin({
    clientFactory: () => boat.client,
    now: () => now,
    sleep: async () => {},
    randomId: () => {
      randomIds += 1;
      return `rid-${randomIds}`;
    },
  })(fake.bb);
  const provider = fake.harness.registrations.machineProviders.get(PROVIDER_ID);
  if (!provider) throw new Error("provider not registered");
  const checkpoints: JsonValue[] = [];
  const createContext = (inputs: JsonValue = {}): PluginMachineProviderCreateContext => ({
    key: KEY,
    attempt: 1,
    inputs,
    report,
    signal: new AbortController().signal,
    checkpoint: async (resource) => {
      checkpoints.push(resource);
      resources.set(HOST_ID, resource);
    },
  });
  const lifecycleContext = () => ({
    hostId: HOST_ID,
    resource: resources.get(HOST_ID)!,
    report,
    signal: new AbortController().signal,
    checkpoint: async (resource: JsonValue) => {
      resources.set(HOST_ID, resource);
    },
  });
  return {
    fake,
    boat,
    provider,
    bootstrap,
    checkpoints,
    resources,
    hostList,
    suspended,
    createContext,
    lifecycleContext,
    advance: (ms: number) => {
      now += ms;
    },
    time: () => now,
    setOccupyingThreads: (count: number) => {
      occupyingThreads = count;
    },
    setCoreBusy: (busy: boolean) => {
      coreBusy = busy;
    },
  };
}

describe("boat sandbox plugin", () => {
  test("needs configuration without an API key and reports it through the CLI", async () => {
    const { fake } = await setup({});
    expect(fake.harness.needsConfigurationMessages).toEqual([
      "Set apiKey in the plugin's settings.",
    ]);
    const result = await fake.harness.runCli(["account", "inspect", "--json"]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ available: false });
  });

  test("registers the machine provider and its project-checkout composition", async () => {
    const { fake } = await setup();
    expect(fake.harness.registrations.environmentCompositions.get(PROVIDER_ID)).toMatchObject({
      machineProviderId: PROVIDER_ID,
      environmentProviderId: "project-checkout",
    });
    await expect(fake.harness.callRpc("account.inspect", {})).resolves.toEqual({
      available: true,
      message: "Connected to Boat as scott, 1 of 100 sandboxes running",
    });
    await expect(fake.harness.callRpc("launch.options", {})).resolves.toMatchObject({
      defaultType: "default",
      snapshots: ["web-stack"],
    });
  });

  test("create allocates a sandbox, checkpoints before bootstrap, and names the machine after it", async () => {
    const { provider, boat, bootstrap, checkpoints, createContext } = await setup();
    const result = await provider.create(createContext({ type: "large", from: "web-stack" }));
    expect(result).toEqual({
      status: "created",
      name: "Boat bx_00000001",
      resource: {
        key: KEY,
        sandboxId: "bx_00000001",
        accountIdentity: "account-a",
        type: "large",
        from: "web-stack",
        environment: null,
      },
    });
    expect(boat.creates[0]).toMatchObject({
      key: KEY,
      idempotencyKey: "bb-machine-thread-key-1-rid-1",
      type: "large",
      from: "web-stack",
      ttlSeconds: 24 * 3600,
    });
    expect(checkpoints).toHaveLength(1);
    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(boat.sandboxes[0]?.state).toBe("ready");
  });

  test("a retried create reuses the sandbox already labelled with the key", async () => {
    const { provider, boat, createContext } = await setup();
    await provider.create(createContext());
    const again = await provider.create(createContext());
    expect(again).toMatchObject({ status: "created", resource: { sandboxId: "bx_00000001" } });
    expect(boat.creates).toHaveLength(1);
  });

  test("a retried create waits for an archiving sandbox to stop, then resumes it", async () => {
    const { provider, boat, createContext } = await setup();
    await provider.create(createContext());
    boat.sandboxes[0]!.state = "archiving";
    const again = await provider.create(createContext());
    expect(again).toMatchObject({ status: "created", resource: { sandboxId: "bx_00000001" } });
    expect(boat.creates).toHaveLength(1);
    expect(boat.resumes).toEqual([{ id: "bx_00000001", ttlSeconds: 24 * 3600 }]);
    expect(boat.sandboxes[0]?.state).toBe("ready");
  });

  test("create retries a transient Boat failure with a fresh idempotency key per allocation", async () => {
    const { provider, boat, createContext, lifecycleContext } = await setup();
    boat.failNextCreate(new BoatApiError(503, "no_ready_machine", "Boat no_ready_machine", null));
    await expect(provider.create(createContext())).resolves.toMatchObject({ status: "created" });
    expect(boat.creates).toHaveLength(1);
    await provider.remove(lifecycleContext());
    boat.finishDeletes();
    await provider.create(createContext());
    expect(boat.creates.map((request) => request.idempotencyKey)).toEqual([
      "bb-machine-thread-key-1-rid-1",
      "bb-machine-thread-key-1-rid-3",
    ]);
  });

  test("create refuses an unknown size before touching Boat", async () => {
    const { provider, boat, createContext } = await setup();
    await expect(
      Promise.resolve(provider.validate?.({ inputs: { type: "huge" } })),
    ).resolves.toMatchObject({ action: "refuse" });
    const result = await provider.create(createContext({ type: "huge" }));
    expect(result).toMatchObject({ status: "failed" });
    expect(boat.creates).toHaveLength(0);
  });

  test("suspend stops the sandbox and waits for Boat to save its disk; a second suspend is a no-op", async () => {
    const { provider, boat, createContext, lifecycleContext } = await setup();
    await provider.create(createContext());
    const first = await provider.suspend!(lifecycleContext());
    expect(boat.stops).toEqual(["bx_00000001"]);
    expect(boat.sandboxes[0]?.state).toBe("archived");
    expect(readMachineResource(first.resource).sandboxId).toBe("bx_00000001");
    await provider.suspend!(lifecycleContext());
    expect(boat.stops).toHaveLength(1);
  });

  test("resume brings a stopped sandbox back with the configured auto-stop and reinstalls the daemon", async () => {
    const { provider, boat, bootstrap, createContext, lifecycleContext } = await setup();
    await provider.create(createContext());
    await provider.suspend!(lifecycleContext());
    await provider.resume!(lifecycleContext());
    expect(boat.resumes).toEqual([{ id: "bx_00000001", ttlSeconds: 24 * 3600 }]);
    expect(boat.sandboxes[0]?.state).toBe("ready");
    expect(bootstrap).toHaveBeenCalledTimes(2);
  });

  test("resume of a sandbox that is already running does not resume it twice", async () => {
    const { provider, boat, createContext, lifecycleContext } = await setup();
    await provider.create(createContext());
    await provider.resume!(lifecycleContext());
    expect(boat.resumes).toHaveLength(0);
  });

  test("resume refuses a sandbox whose disk Boat has deleted", async () => {
    const { provider, boat, createContext, lifecycleContext } = await setup();
    await provider.create(createContext());
    await provider.suspend!(lifecycleContext());
    boat.sandboxes[0]!.dataExpiredAt = "2026-11-12T00:00:00Z";
    await expect(provider.resume!(lifecycleContext())).rejects.toThrow(/14 days/);
    expect(boat.resumes).toHaveLength(0);
  });

  test("lifecycle refuses to act through another Boat account", async () => {
    const first = await setup();
    await first.provider.create(first.createContext());
    // A reconfigured plugin whose key belongs to another account inherits the machine's resource.
    const other = await setup(SETTINGS, { identity: "account-b" });
    await expect(
      other.provider.suspend!({
        ...other.lifecycleContext(),
        resource: first.resources.get(HOST_ID)!,
      }),
    ).rejects.toThrow(/pinned Boat account/);
    expect(first.boat.stops).toEqual([]);
  });

  test("remove deletes the sandbox and reconcileCleanup deletes allocations by key", async () => {
    const { provider, boat, createContext, lifecycleContext } = await setup();
    await provider.create(createContext());
    await expect(provider.remove(lifecycleContext())).resolves.toEqual({ status: "removed" });
    expect(boat.deletes).toEqual(["bx_00000001"]);
    await boat.client.create({
      key: KEY,
      idempotencyKey: "orphan",
      name: "orphan",
      type: "default",
      from: null,
      environment: null,
      ttlSeconds: null,
    });
    await expect(
      provider.reconcileCleanup({ key: KEY, report, signal: new AbortController().signal }),
    ).resolves.toEqual({ status: "removed" });
    expect(boat.deletes).toEqual(["bx_00000001", "bx_00000002"]);
    expect(boat.sandboxes.every((sandbox) => sandbox.deleted)).toBe(true);
  });

  test("reconcileCleanup refuses to conclude through another Boat account", async () => {
    const first = await setup();
    await first.provider.create(first.createContext());
    const record = await first.fake.bb.storage.kv.get(`allocations/${KEY}`);
    expect(record).toEqual({ accountIdentity: "account-a", apiBase: "https://boat.dev/api/v1" });
    // The key was switched to another account before cleanup; that account lists nothing for the key.
    const other = await setup(SETTINGS, { identity: "account-b" });
    await other.fake.bb.storage.kv.set(`allocations/${KEY}`, record!);
    const result = await other.provider.reconcileCleanup({
      key: KEY,
      report,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ status: "failed", message: /another Boat account/ });
    expect(first.boat.sandboxes[0]?.deleted).toBe(false);
  });

  test("machine inspect reads Boat's current state for a host", async () => {
    const { fake, provider, createContext, lifecycleContext } = await setup();
    await provider.create(createContext());
    const result = await fake.harness.runCli(["machine", "inspect", HOST_ID, "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      state: "running",
      sandboxId: "bx_00000001",
      type: "default",
      dataExpired: false,
      error: null,
    });
    await provider.suspend!(lifecycleContext());
    await expect(
      fake.harness.callRpc("machine.inspect", { hostId: HOST_ID }),
    ).resolves.toMatchObject({
      state: "stopped",
      summary: "Boat sandbox bx_00000001 is stopped.",
    });
  });

  test("machine inspect reports a sandbox deleted outside bb as missing", async () => {
    const { fake, provider, boat, createContext } = await setup();
    await provider.create(createContext());
    boat.sandboxes[0]!.deleted = true;
    const result = await fake.harness.runCli(["machine", "inspect", HOST_ID, "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      state: "missing",
      sandboxId: "bx_00000001",
      summary: expect.stringMatching(/missing/),
    });
  });

  describe("idle policy", () => {
    test("stops a machine through core after the idle window, counting thread and terminal activity", async () => {
      const { fake, provider, createContext, hostList, suspended, advance } = await setup();
      await provider.create(createContext());
      hostList.push(host());
      await fake.harness.runSchedule(IDLE_SWEEP_SCHEDULE);
      expect(suspended).toEqual([]);
      advance(10 * 60_000);
      await fake.harness.emitThreadEvent("experimental_thread.events", {
        thread: makeThreadResponse({ id: "t1", status: "active", environmentId: "env_1" }),
        sequence: 1,
      });
      advance(10 * 60_000);
      await fake.harness.runSchedule(IDLE_SWEEP_SCHEDULE);
      expect(suspended).toEqual([]);
      advance(16 * 60_000);
      await fake.harness.runSchedule(IDLE_SWEEP_SCHEDULE);
      expect(suspended).toEqual([HOST_ID]);
    });

    test("a thread running quietly on the host keeps an idle machine alive", async () => {
      const { fake, provider, createContext, hostList, suspended, advance, setOccupyingThreads } =
        await setup();
      await provider.create(createContext());
      hostList.push(host());
      await fake.harness.runSchedule(IDLE_SWEEP_SCHEDULE);
      setOccupyingThreads(1);
      advance(16 * 60_000);
      await fake.harness.runSchedule(IDLE_SWEEP_SCHEDULE);
      expect(suspended).toEqual([]);
      setOccupyingThreads(0);
      advance(16 * 60_000);
      await fake.harness.runSchedule(IDLE_SWEEP_SCHEDULE);
      expect(suspended).toEqual([HOST_ID]);
    });

    test("keeps extending Boat's auto-stop while core defers an idle stop", async () => {
      const {
        fake,
        provider,
        boat,
        createContext,
        hostList,
        suspended,
        advance,
        time,
        setCoreBusy,
      } = await setup();
      await provider.create(createContext());
      hostList.push(host());
      await fake.harness.runSchedule(IDLE_SWEEP_SCHEDULE);
      setCoreBusy(true);
      advance(16 * 60_000);
      boat.sandboxes[0]!.archiveAfter = new Date(time() + 2 * 3600_000).toISOString();
      await fake.harness.runSchedule(IDLE_SWEEP_SCHEDULE);
      expect(suspended).toEqual([]);
      expect(boat.extends).toEqual([{ id: "bx_00000001", ttlSeconds: 24 * 3600 }]);
    });

    test("converges core when Boat stopped the sandbox on its own", async () => {
      const { fake, provider, boat, createContext, hostList, suspended } = await setup();
      await provider.create(createContext());
      hostList.push(host());
      boat.sandboxes[0]!.state = "archived";
      await fake.harness.runSchedule(IDLE_SWEEP_SCHEDULE);
      expect(suspended).toEqual([HOST_ID]);
    });

    test("extends Boat's auto-stop while the machine is active and the deadline is near", async () => {
      const { fake, provider, boat, createContext, hostList, advance, time } = await setup();
      await provider.create(createContext());
      hostList.push(host());
      boat.sandboxes[0]!.archiveAfter = new Date(time() + 2 * 3600_000).toISOString();
      await fake.harness.runSchedule(IDLE_SWEEP_SCHEDULE);
      expect(boat.extends).toEqual([{ id: "bx_00000001", ttlSeconds: 24 * 3600 }]);
      advance(60_000);
      await fake.harness.emitThreadEvent("experimental_terminal.input", {
        terminal: { hostId: HOST_ID } as never,
      });
      await fake.harness.runSchedule(IDLE_SWEEP_SCHEDULE);
      expect(boat.extends).toHaveLength(1);
    });

    test("idle stop off leaves stopping to Boat: no core stop and no auto-stop extension", async () => {
      const { fake, provider, boat, createContext, hostList, suspended, advance, time } =
        await setup({ ...SETTINGS, idleMinutes: 0 });
      await provider.create(createContext());
      hostList.push(host());
      await fake.harness.runSchedule(IDLE_SWEEP_SCHEDULE);
      advance(48 * 3600_000);
      boat.sandboxes[0]!.archiveAfter = new Date(time() + 2 * 3600_000).toISOString();
      await fake.harness.runSchedule(IDLE_SWEEP_SCHEDULE);
      expect(suspended).toEqual([]);
      expect(boat.extends).toEqual([]);
    });
  });
});
