import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createFakePluginHost,
  makeHostResponse,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { IDLE_MS, type Inspection, type Resource } from "../../shared/schema.ts";
import { createService } from "./service.ts";
import { Store } from "./store.ts";

const resource: Resource = {
  project: "test-project",
  zone: "us-west1-a",
  instance: "test-vm",
  instanceId: "1234",
  controllerHostId: "controller",
  access: { gcloudPath: "gcloud", account: "", sshUser: "test" },
  key: "enrollment",
};
const vm = {
  kind: "present",
  id: "1234",
  name: "test-vm",
  status: "RUNNING",
  persistentDisksOnly: true,
} satisfies Inspection;
const missing = { kind: "missing", id: "1234", name: "test-vm" } satisfies Inspection;
type Thread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["list"]>>[number];
type Env = Awaited<ReturnType<BbPluginApi["sdk"]["environments"]["list"]>>[number];
const thread = (id = "thread"): Thread =>
  ({
    ...makeThreadResponse({ id, environmentId: "env" }),
    activity: {
      activeBackgroundAgentCount: 0,
      activeBackgroundCommandCount: 0,
      activeGoalCount: 0,
      activePlanModeCount: 0,
      activeWorkflowCount: 0,
    },
    environmentHostId: "vm",
    queuedWork: "none",
    environmentBranchName: null,
    environmentIsWorktree: false,
    environmentName: "env",
    environmentPath: "/workspace",
    environmentProviderId: "project-checkout",
    environmentWorkspaceDisplayKind: "other",
    hasPendingInteraction: false,
    pinSortKey: null,
  }) as Thread;
const environment = {
  id: "env",
  hostId: "vm",
  status: "ready",
  lifecycle: { phase: "active" },
} as Env;

function fixture() {
  let time = 1000;
  let onInspect: (() => void | Promise<void>) | undefined;
  const host = makeHostResponse({
    id: "vm",
    status: "connected",
    machineProviderId: "gcp-machine",
    lifecycle: {
      phase: "active",
      message: null,
      pendingLog: "",
      suspendedAt: null,
      teardown: null,
    },
  });
  const state = {
    threads: [thread()],
    environments: [environment],
    terminalScope: "",
    terminalStatus: "running",
    active: 0,
    suspend: 0,
    power: [] as string[],
    powerFail: false,
    notSubmitted: false,
    cloud: vm as Inspection,
    bootstrapKeys: [] as string[],
  };
  const fake = createFakePluginHost({
    pluginId: "gcp-machine",
    settings: {
      project: resource.project,
      zone: resource.zone,
      instance: resource.instance,
      instanceId: resource.instanceId,
      controllerHostId: resource.controllerHostId,
      ...resource.access,
    },
    sdk: {
      hosts: {
        get: async () => host,
        experimental_suspend: async () => {
          state.suspend++;
          return host;
        },
        experimental_resume: async () => host,
        list: async () => [],
      },
      threads: {
        count: async () => ({ total: state.active }),
        list: async ({ offset = 0, limit = 100, archived = false } = {}) =>
          archived ? [] : state.threads.slice(offset, offset + limit),
      },
      environments: { list: async () => state.environments, get: async () => environment },
      terminals: {
        list: async ({ scope }) => ({
          sessions: scope.kind === state.terminalScope ? [{ status: state.terminalStatus }] : [],
        }),
      },
    },
    experimental_callHostRpc: async ({ method, input }) => {
      if (method === "inspect") {
        await onInspect?.();
        return state.cloud;
      }
      if (method === "power") {
        const { action, requestId } = input as { action: string; requestId: string };
        state.power.push(`${action}:${requestId}`);
        if (state.powerFail) throw new Error("connection lost");
        if (state.notSubmitted)
          return { outcome: "not-submitted", error: "authentication unavailable" };
        return {
          outcome: "completed",
          vm: { ...vm, status: action === "stop" ? "TERMINATED" : "RUNNING" },
        };
      }
      throw new Error(`unexpected ${method}`);
    },
  });
  fake.bb.experimental_machines.bootstrap = async ({ key }) => {
    state.bootstrapKeys.push(key);
    return { hostId: "vm" };
  };
  const store = new Store(fake.bb);
  store.reserve(resource);
  store.attach(resource.key, "vm");
  store.touch("vm", time);
  const service = createService(fake.bb, () => time);
  service.register();
  return {
    ...fake,
    store,
    service,
    state,
    host,
    advance: (amount = IDLE_MS) => {
      time += amount;
    },
    inspect: (fn: typeof onInspect) => {
      onInspect = fn;
    },
    now: () => time,
  };
}

test("idle stop waits a full hour and delegates suspension to BB", async (t) => {
  const f = fixture();
  t.after(() => f.harness.lifecycle.dispose());
  f.advance(IDLE_MS - 1);
  await f.service.sweep();
  assert.equal(f.state.suspend, 0);
  f.advance(1);
  await f.service.sweep();
  assert.equal(f.state.suspend, 1);
  assert.deepEqual(f.state.power, []);
});

for (const scope of ["host_path", "environment", "thread"]) {
  for (const status of ["starting", "running", "disconnected"]) {
    test(`${scope} ${status} terminal inhibits shutdown without input`, async (t) => {
      const f = fixture();
      t.after(() => f.harness.lifecycle.dispose());
      f.state.terminalScope = scope;
      f.state.terminalStatus = status;
      f.advance(2 * IDLE_MS);
      await f.service.sweep();
      assert.equal(f.state.suspend, 0);
      f.state.terminalStatus = "exited";
      f.advance(IDLE_MS - 1);
      await f.service.sweep();
      assert.equal(f.state.suspend, 0);
      f.advance(1);
      await f.service.sweep();
      assert.equal(f.state.suspend, 1);
    });
  }
}

test("active work and queued/background work keep the machine awake", async (t) => {
  const f = fixture();
  t.after(() => f.harness.lifecycle.dispose());
  f.state.active = 1;
  f.advance();
  await f.service.sweep();
  assert.equal(f.state.suspend, 0);
  f.state.active = 0;
  f.state.threads[0]!.queuedWork = "waiting";
  f.advance();
  await f.service.sweep();
  assert.equal(f.state.suspend, 0);
  f.state.threads[0]!.queuedWork = "none";
  f.state.threads[0]!.activity.activeBackgroundCommandCount = 1;
  f.advance();
  await f.service.sweep();
  assert.equal(f.state.suspend, 0);
});

test("a busy thread past the first page is not overlooked", async (t) => {
  const f = fixture();
  t.after(() => f.harness.lifecycle.dispose());
  f.state.threads = Array.from({ length: 101 }, (_, i) => thread(`thread${i}`));
  f.state.threads[100]!.queuedWork = "waiting";
  f.advance();
  await f.service.sweep();
  assert.equal(f.state.suspend, 0);
  assert.equal(f.harness.inspection.sdk.callsTo("threads.list").length, 2);
});

test("disconnects and incomplete observations restart the grace period", async (t) => {
  const f = fixture();
  t.after(() => f.harness.lifecycle.dispose());
  f.host.status = "disconnected";
  f.advance();
  await f.service.sweep();
  assert.equal(f.state.suspend, 0);
  f.host.status = "connected";
  f.advance(IDLE_MS - 1);
  await f.service.sweep();
  assert.equal(f.state.suspend, 0);
  f.advance(1);
  f.inspect(() => {
    throw new Error("controller offline");
  });
  await f.service.sweep();
  assert.equal(f.state.suspend, 0);
  f.inspect(undefined);
  await f.service.sweep();
  assert.equal(f.state.suspend, 0);
  f.advance();
  await f.service.sweep();
  assert.equal(f.state.suspend, 1);
});

test("new activity during cloud preflight defers shutdown", async (t) => {
  const f = fixture();
  t.after(() => f.harness.lifecycle.dispose());
  f.inspect(async () => {
    f.advance(1);
    await f.harness.behavior.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ environmentId: "env" }),
    });
  });
  f.advance();
  await f.service.sweep();
  assert.equal(f.state.suspend, 0);
});

test("disabled auto-stop and reload both grant fresh idle grace", async (t) => {
  const f = fixture();
  t.after(() => f.harness.lifecycle.dispose());
  await f.harness.behavior.setSettings({ autoStop: false });
  f.advance();
  await f.service.sweep();
  assert.equal(f.state.suspend, 0);
  await f.harness.behavior.setSettings({ autoStop: true });
  let reloaded = f.service;
  f.advance();
  await f.harness.lifecycle.reload((bb) => {
    reloaded = createService(bb, f.now);
    reloaded.register();
  });
  await reloaded.sweep();
  assert.equal(f.state.suspend, 0);
  f.advance();
  await reloaded.sweep();
  assert.equal(f.state.suspend, 1);
});

test("an uncertain stop is retried with the same UUID before a newer start", async (t) => {
  const f = fixture();
  t.after(() => f.harness.lifecycle.dispose());
  const provider = f.harness.inspection.registrations.machineProviders.get("gcp-machine")!;
  const ctx = {
    hostId: "vm",
    resource,
    signal: new AbortController().signal,
    report: { step() {}, log() {} },
    checkpoint: async () => {},
  };
  f.state.powerFail = true;
  await assert.rejects(provider.suspend!(ctx), /connection lost/);
  f.state.powerFail = false;
  await provider.resume!(ctx);
  assert.equal(f.state.power.length, 3);
  assert.equal(f.state.power[0], f.state.power[1]);
  assert.match(f.state.power[2]!, /^start:/);
  assert.deepEqual(f.state.bootstrapKeys, [resource.key]);
});

const lifecycleContext = () => ({
  hostId: "vm",
  resource,
  signal: new AbortController().signal,
  report: { step() {}, log() {} },
  checkpoint: async () => {},
});

test("resume waits for BB's existing-enrollment restart before succeeding", async (t) => {
  const f = fixture();
  t.after(() => f.harness.lifecycle.dispose());
  const provider = f.harness.inspection.registrations.machineProviders.get("gcp-machine")!;
  f.bb.experimental_machines.bootstrap = async ({ key }) => {
    assert.equal(key, resource.key);
    assert.match(f.state.power.at(-1)!, /^start:/);
    throw new Error("daemon failed to reconnect");
  };
  await assert.rejects(provider.resume!(lifecycleContext()), /daemon failed to reconnect/);
});

test("failed enrollment preflight can be cleaned up and configured again", async (t) => {
  const f = fixture();
  t.after(() => f.harness.lifecycle.dispose());
  const provider = f.harness.inspection.registrations.machineProviders.get("gcp-machine")!;
  f.store.release(resource.key);
  f.inspect(() => {
    throw new Error("wrong instance ID or gcloud path");
  });
  const ctx = { ...lifecycleContext(), key: resource.key, attempt: 1, inputs: {} };
  await assert.rejects(provider.create(ctx), /wrong instance ID/);
  assert.equal(f.store.pendingPower(resource.key), undefined);
  await provider.reconcileCleanup(ctx);
  assert.equal(f.store.binding(), null);
  f.inspect(undefined);
  assert.equal((await provider.create({ ...ctx, key: "corrected-enrollment" })).status, "created");
});

test("confirmed pre-dispatch failure is released but cannot erase an earlier uncertain operation", async (t) => {
  const f = fixture();
  t.after(() => f.harness.lifecycle.dispose());
  const provider = f.harness.inspection.registrations.machineProviders.get("gcp-machine")!;
  f.state.notSubmitted = true;
  await assert.rejects(provider.suspend!(lifecycleContext()), /authentication unavailable/);
  assert.equal(f.store.pendingPower(resource.key), undefined);
  f.state.notSubmitted = false;
  f.state.powerFail = true;
  await assert.rejects(provider.suspend!(lifecycleContext()), /connection lost/);
  const pending = f.store.pendingPower(resource.key);
  f.state.powerFail = false;
  f.state.notSubmitted = true;
  await assert.rejects(provider.suspend!(lifecycleContext()), /authentication unavailable/);
  assert.deepEqual(f.store.pendingPower(resource.key), pending);
});

test("controller credentials can be repaired without changing a pending operation's VM identity", async (t) => {
  const f = fixture();
  t.after(() => f.harness.lifecycle.dispose());
  const provider = f.harness.inspection.registrations.machineProviders.get("gcp-machine")!;
  f.state.powerFail = true;
  await assert.rejects(provider.suspend!(lifecycleContext()), /connection lost/);
  await f.harness.behavior.setSettings({
    controllerHostId: "new-controller",
    gcloudPath: "/new/gcloud",
    instanceId: "9876",
  });
  f.state.powerFail = false;
  await provider.resume!(lifecycleContext());
  const call = f.harness.inspection.experimental_hostRpcCalls.findLast(
    (call) => call.method === "power",
  )!;
  assert.equal(call.hostId, "new-controller");
  assert.equal((call.input as { access: { gcloudPath: string } }).access.gcloudPath, "/new/gcloud");
  assert.equal((call.input as { target: { instanceId: string } }).target.instanceId, "1234");
});

test("removing a registration retains the VM and disks", async (t) => {
  const f = fixture();
  t.after(() => f.harness.lifecycle.dispose());
  const provider = f.harness.inspection.registrations.machineProviders.get("gcp-machine")!;
  await provider.remove({
    hostId: "vm",
    resource,
    signal: new AbortController().signal,
    report: { step() {}, log() {} },
  });
  assert.deepEqual(f.state.power, []);
  assert.equal(f.store.binding(), null);
});

for (const cleanup of ["remove", "reconcileCleanup"] as const) {
  test(`${cleanup} releases an uncertain operation after the pinned VM is deleted`, async (t) => {
    const f = fixture();
    t.after(() => f.harness.lifecycle.dispose());
    const provider = f.harness.inspection.registrations.machineProviders.get("gcp-machine")!;
    f.state.powerFail = true;
    await assert.rejects(provider.suspend!(lifecycleContext()), /connection lost/);
    assert.ok(f.store.pendingPower(resource.key));
    f.state.cloud = missing;
    await provider[cleanup]({ ...lifecycleContext(), key: resource.key });
    assert.equal(f.store.pendingPower(resource.key), undefined);
    assert.equal(f.store.binding(), null);
    assert.equal(f.state.power.length, 1);
    f.store.reserve({ ...resource, key: "replacement-enrollment", instanceId: "5678" });
    assert.equal(f.store.binding()?.resource.instanceId, "5678");
  });
}

test("an unreadable VM preserves an uncertain operation during removal", async (t) => {
  const f = fixture();
  t.after(() => f.harness.lifecycle.dispose());
  const provider = f.harness.inspection.registrations.machineProviders.get("gcp-machine")!;
  f.state.powerFail = true;
  await assert.rejects(provider.suspend!(lifecycleContext()), /connection lost/);
  const pending = f.store.pendingPower(resource.key);
  f.inspect(() => {
    throw new Error("Google Compute GET failed (HTTP 403)");
  });
  await assert.rejects(provider.remove(lifecycleContext()), /HTTP 403/);
  assert.deepEqual(f.store.pendingPower(resource.key), pending);
  assert.equal(f.store.binding()?.hostId, "vm");
});

test("resume refuses a deleted VM without bootstrapping a replacement", async (t) => {
  const f = fixture();
  t.after(() => f.harness.lifecycle.dispose());
  f.state.cloud = missing;
  const provider = f.harness.inspection.registrations.machineProviders.get("gcp-machine")!;
  await assert.rejects(provider.resume!(lifecycleContext()), /no longer exists/);
  assert.deepEqual(f.state.bootstrapKeys, []);
  assert.deepEqual(f.state.power, []);
});

test("Wake starts a VM stopped outside BB and reports its actual connection state", async (t) => {
  const f = fixture();
  t.after(() => f.harness.lifecycle.dispose());
  f.host.status = "disconnected";
  f.state.cloud = { ...vm, status: "TERMINATED" };
  const result = await f.service.wake();
  assert.equal(result.status, "disconnected");
  assert.equal(f.state.power.length, 1);
  assert.match(f.state.power[0]!, /^start:/);
  assert.deepEqual(f.state.bootstrapKeys, [resource.key]);
  assert.equal(f.harness.inspection.sdk.callsTo("hosts.experimental_resume").length, 0);
});

test("Wake reports a deleted VM instead of blaming the daemon connection", async (t) => {
  const f = fixture();
  t.after(() => f.harness.lifecycle.dispose());
  f.host.status = "disconnected";
  f.state.cloud = missing;
  await assert.rejects(f.service.wake(), /no longer exists/);
  assert.deepEqual(f.state.power, []);
  assert.deepEqual(f.state.bootstrapKeys, []);
});

test("status reports a deleted VM as missing rather than as a VM without persistent disks", async (t) => {
  const f = fixture();
  t.after(() => f.harness.lifecycle.dispose());
  f.state.cloud = missing;
  assert.deepEqual((await f.service.status()).cloud, missing);
});

test("Wake repairs a disconnected daemon on a running VM using its enrollment key", async (t) => {
  const f = fixture();
  t.after(() => f.harness.lifecycle.dispose());
  f.host.status = "disconnected";
  f.bb.experimental_machines.bootstrap = async ({ key }) => {
    assert.equal(key, resource.key);
    f.host.status = "connected";
    return { hostId: "vm" };
  };
  assert.equal((await f.service.wake()).status, "connected");
});

test("Wake propagates daemon restart failures without claiming a connection", async (t) => {
  const f = fixture();
  t.after(() => f.harness.lifecycle.dispose());
  f.host.status = "disconnected";
  f.bb.experimental_machines.bootstrap = async () => {
    throw new Error("daemon restart failed");
  };
  await assert.rejects(f.service.wake(), /daemon restart failed/);
});

test("Wake leaves an already connected daemon alone", async (t) => {
  const f = fixture();
  t.after(() => f.harness.lifecycle.dispose());
  assert.equal((await f.service.wake()).status, "connected");
  assert.deepEqual(f.state.bootstrapKeys, []);
  assert.deepEqual(f.state.power, []);
});

test("setup and cleanup prevent the idle deadline from advancing", async (t) => {
  const f = fixture();
  t.after(() => f.harness.lifecycle.dispose());
  f.state.environments = [{ ...environment, status: "provisioning" }];
  f.advance();
  await f.service.sweep();
  assert.equal(f.state.suspend, 0);
  f.state.environments = [
    { ...environment, lifecycle: { ...environment.lifecycle, phase: "teardown" } },
  ];
  f.advance();
  await f.service.sweep();
  assert.equal(f.state.suspend, 0);
});

test("a disconnected terminal in an archived thread still inhibits stop", async (t) => {
  const f = fixture();
  t.after(() => f.harness.lifecycle.dispose());
  f.harness.inspection.sdk.stub("threads.list", async (args: { archived?: boolean } | undefined) =>
    args?.archived ? [thread("archived")] : [],
  );
  f.state.terminalScope = "thread";
  f.state.terminalStatus = "disconnected";
  f.advance();
  await f.service.sweep();
  assert.equal(f.state.suspend, 0);
});

test("overlapping timer ticks cannot request two suspensions", async (t) => {
  const f = fixture();
  t.after(() => f.harness.lifecycle.dispose());
  let release!: () => void;
  let notifyInspection!: () => void;
  const inspected = new Promise<void>((resolve) => {
    notifyInspection = resolve;
  });
  f.inspect(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
        notifyInspection();
      }),
  );
  f.advance();
  const pending = f.service.sweep();
  await inspected;
  assert.ok(release);
  await f.service.sweep();
  release();
  await pending;
  assert.equal(f.state.suspend, 1);
});

test("an unacknowledged suspend does not permanently disable later idle checks", async (t) => {
  const f = fixture();
  t.after(() => f.harness.lifecycle.dispose());
  t.mock.timers.enable({ apis: ["setTimeout"] });
  f.harness.inspection.sdk.stub("hosts.experimental_suspend", async () => new Promise(() => {}));
  f.advance();
  const first = f.service.sweep();
  for (let i = 0; i < 100; i++) {
    if (f.harness.inspection.sdk.callsTo("hosts.experimental_suspend").length) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(f.harness.inspection.sdk.callsTo("hosts.experimental_suspend").length, 1);
  t.mock.timers.tick(30_000);
  await first;
  f.harness.inspection.sdk.stub("hosts.experimental_suspend", async () => f.host);
  f.advance();
  await f.service.sweep();
  assert.equal(f.harness.inspection.sdk.callsTo("hosts.experimental_suspend").length, 2);
});
