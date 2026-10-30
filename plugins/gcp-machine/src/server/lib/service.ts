import { randomUUID } from "node:crypto";
import type { BbPluginApi, MachineExecutorRequest } from "@get-bb/plugin-sdk";
import type { PluginMachineProviderProgress } from "@get-bb/plugin-sdk/machine-provider";
import { GoogleCompute } from "../../shared/node/cloud.ts";
import { hostContract } from "../../shared/host-contract.ts";
import { IDLE_MS, PROVIDER_ID, resourceSchema, type Resource } from "../../shared/schema.ts";
import { busyReason } from "./activity.ts";
import { Store } from "./store.ts";

export function createService(bb: BbPluginApi, now = Date.now) {
  const settings = bb.settings.define({
    project: { type: "string", label: "Google Cloud project ID", default: "" },
    zone: { type: "string", label: "Compute Engine zone", default: "" },
    instance: { type: "string", label: "Existing VM name", default: "" },
    instanceId: { type: "string", label: "Existing VM numeric ID", default: "" },
    controllerHostId: {
      type: "string",
      label: "Controller BB machine ID (empty uses the BB server)",
      default: "",
    },
    gcloudPath: { type: "string", label: "gcloud executable on the controller", default: "gcloud" },
    account: {
      type: "string",
      label: "gcloud account (empty uses its active account)",
      default: "",
    },
    sshUser: { type: "string", label: "VM login user for enrollment", default: "" },
    previousHostId: {
      type: "string",
      label: "Previous manual BB machine ID (remove before enrollment)",
      default: "",
    },
    autoStop: { type: "boolean", label: "Stop after one hour without BB work", default: true },
  });
  const store = new Store(bb);
  const local = new GoogleCompute();
  const remote = bb.hosts.experimental_client({ contract: hostContract });
  const lifetime = new AbortController();
  const bootAt = now();
  const existingHostId = store.binding()?.hostId;
  if (existingHostId) store.touch(existingHostId, bootAt);
  const environmentHosts = new Map<string, string>();
  let sweeping = false;
  let lastError: string | null = null;
  let idleStatus = "Waiting for a provider-managed machine";
  const signal = (timeoutMs = 30_000) =>
    AbortSignal.any([lifetime.signal, AbortSignal.timeout(timeoutMs)]);
  bb.onDispose(() => lifetime.abort());

  async function configured(key: string) {
    const values = await settings.get();
    return resourceSchema.parse({
      project: values.project,
      zone: values.zone,
      instance: values.instance,
      instanceId: values.instanceId,
      controllerHostId: values.controllerHostId,
      access: { gcloudPath: values.gcloudPath, account: values.account, sshUser: values.sshUser },
      key,
    });
  }
  async function inspect(resource: Resource, requestSignal = signal()) {
    resource = await executionResource(resource);
    const input = { target: target(resource), access: resource.access };
    return resource.controllerHostId
      ? remote.call("inspect", input, { hostId: resource.controllerHostId, signal: requestSignal })
      : local.inspect(input.target, input.access, requestSignal);
  }
  async function power(resource: Resource, action: "start" | "stop", requestSignal: AbortSignal) {
    resource = await executionResource(resource);
    let pending = store.pendingPower(resource.key);
    // A previous uncertain stop/start must settle before an opposite operation is sent.
    if (pending && pending.action !== action) {
      await power(resource, pending.action, requestSignal);
      pending = undefined;
    }
    // Inspect without an intent first: bad credentials or identity cannot poison cleanup.
    const vm = await inspect(resource, requestSignal);
    if (vm.status === "NOT_FOUND") {
      // Numeric IDs are immutable: a late operation cannot affect a replacement.
      store.finishPower(resource.key);
      return { outcome: "gone" as const };
    }
    const requestId = store.powerRequest(resource.key, action, randomUUID());
    const input = { target: target(resource), access: resource.access, action, requestId };
    const result = resource.controllerHostId
      ? await remote.call("power", input, {
          hostId: resource.controllerHostId,
          signal: requestSignal,
          timeoutMs: 9 * 60_000,
        })
      : await local.power(input.target, input.access, action, requestId, requestSignal);
    if (result.outcome === "not-submitted") {
      // This response proves only this attempt did not write. An older uncertain
      // attempt with the same UUID must remain available for reconciliation.
      if (!pending) store.finishPower(resource.key);
      throw new Error(result.error);
    }
    store.finishPower(resource.key);
    if (result.outcome === "failed") throw new Error(result.error);
    return result;
  }
  async function bootstrap(resource: Resource, request: MachineExecutorRequest) {
    resource = await executionResource(resource);
    const input = {
      target: target(resource),
      access: resource.access,
      command: request.command,
      stdin: request.stdin,
      timeoutMs: request.timeoutMs,
    };
    const result = resource.controllerHostId
      ? await remote.call("bootstrap", input, {
          hostId: resource.controllerHostId,
          signal: request.signal,
          timeoutMs: Math.min(request.timeoutMs + 30_000, 30 * 60_000),
        })
      : await local.bootstrap(
          input.target,
          input.access,
          input.command,
          input.stdin,
          input.timeoutMs,
          request.signal,
        );
    request.onOutput(result.output);
    return { exitCode: result.exitCode };
  }
  async function restartDaemon(
    resource: Resource,
    expectedHostId: string,
    requestSignal: AbortSignal,
    report: PluginMachineProviderProgress,
  ) {
    const { hostId } = await bb.experimental_machines.bootstrap({
      key: resource.key,
      signal: requestSignal,
      report,
      executor: { exec: (request) => bootstrap(resource, request) },
    });
    if (hostId !== expectedHostId)
      throw new Error("BB restart returned a different machine identity.");
    touch(expectedHostId);
  }
  async function executionResource(resource: Resource): Promise<Resource> {
    const config = await settings.get();
    const current = resourceSchema.parse({
      ...resource,
      controllerHostId: config.controllerHostId,
      access: { gcloudPath: config.gcloudPath, account: config.account, sshUser: config.sshUser },
    });
    if (current.controllerHostId && current.controllerHostId === store.binding()?.hostId) {
      throw new Error("Choose a power controller outside the GCP VM.");
    }
    return current;
  }
  async function touchThread(thread: { id: string; environmentId: string | null }) {
    const binding = store.binding();
    if (!binding?.hostId || !thread.environmentId) return;
    try {
      let hostId = environmentHosts.get(thread.environmentId);
      if (!hostId) {
        const environment = await bb.sdk.environments.get({
          environmentId: thread.environmentId,
          signal: signal(),
        });
        hostId = environment.hostId;
        if (environmentHosts.size >= 2000) environmentHosts.clear();
        environmentHosts.set(thread.environmentId, hostId);
      }
      if (hostId === binding.hostId) store.touch(binding.hostId, now());
    } catch {
      // Unknown activity must postpone shutdown, even if a reconnect lost its event lookup.
      store.touch(binding.hostId, now());
    }
  }
  const touch = (hostId: string) => {
    if (store.binding()?.hostId === hostId) store.touch(hostId, now());
  };

  async function readyForIdleCheck(hostId: string) {
    const config = await settings.get();
    if (!config.autoStop) {
      touch(hostId);
      idleStatus = "Automatic stop is disabled";
      return false;
    }
    const host = await bb.sdk.hosts.get({ hostId, signal: signal() });
    if (host.machineProviderId !== PROVIDER_ID)
      throw new Error("The bound machine is no longer managed by this plugin.");
    if (host.status !== "connected" || host.lifecycle.phase !== "active") {
      touch(hostId);
      idleStatus = `Machine ${host.lifecycle.phase}; connection ${host.status}`;
      return false;
    }
    const reason = await busyReason(bb, hostId, signal(45_000));
    if (reason) {
      touch(hostId);
      idleStatus = reason;
      return false;
    }
    return true;
  }

  async function sweep() {
    if (sweeping || lifetime.signal.aborted) return;
    sweeping = true;
    try {
      const binding = store.binding();
      if (!binding?.hostId) return;
      const hostId = binding.hostId;
      if (!(await readyForIdleCheck(hostId))) return;
      const lastActivity = Math.max(store.lastActivity(hostId) ?? bootAt, bootAt);
      if (now() - lastActivity < IDLE_MS) {
        idleStatus = "Waiting for one hour idle";
        return;
      }
      // Check cloud access and disks before BB interrupts its daemon for suspension.
      const vm = await inspect(binding.resource);
      if (!vm.persistentDisksOnly || vm.status !== "RUNNING")
        throw new Error("VM state does not permit an automatic stop.");
      const finalReason = await busyReason(bb, hostId, signal(45_000));
      const autoStop = (await settings.get()).autoStop;
      if (!autoStop || finalReason || (store.lastActivity(hostId) ?? 0) !== lastActivity) {
        touch(hostId);
        idleStatus = finalReason ?? "New activity postponed shutdown";
        return;
      }
      idleStatus = "Requesting suspension after one hour idle";
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          bb.sdk.hosts.experimental_suspend({ hostId }),
          new Promise<never>((_, reject) => {
            deadline = setTimeout(
              () =>
                reject(
                  new Error(
                    "Suspend acknowledgement timed out; BB lifecycle will be checked again.",
                  ),
                ),
              30_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(deadline);
      }
      touch(hostId);
      lastError = null;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      idleStatus = `Automatic stop deferred: ${lastError}`;
      const hostId = store.binding()?.hostId;
      if (hostId) touch(hostId);
      bb.log.warn(`GCP idle check: ${lastError}`);
    } finally {
      sweeping = false;
    }
  }

  function register() {
    bb.experimental_machines.register({
      id: PROVIDER_ID,
      displayName: "GCP Machine",
      icon: "./assets/icon.svg",
      ephemeral: false,
      description:
        "Use the configured existing Compute Engine VM; wake on work and stop after one hour idle.",
      async availability() {
        try {
          await configured("availability");
          return { status: "available" as const };
        } catch {
          return {
            status: "setup-required" as const,
            message: "Configure the existing VM and controller in GCP Machine settings.",
          };
        }
      },
      async create(ctx) {
        const config = await settings.get();
        if (config.controllerHostId && config.controllerHostId === config.previousHostId) {
          return { status: "failed", message: "Choose a controller outside the GCP VM." };
        }
        if (
          config.previousHostId &&
          (await bb.sdk.hosts.list({ signal: ctx.signal })).some(
            (host) => host.id === config.previousHostId,
          )
        ) {
          return {
            status: "failed",
            message:
              "Remove the previous manual BB registration before enrolling this VM. Check its environments first.",
          };
        }
        const resource = store.reserve(await configured(ctx.key));
        await ctx.checkpoint(resource);
        ctx.report.step("Starting the existing GCP VM");
        if ((await power(resource, "start", ctx.signal)).outcome === "gone")
          throw new Error("The pinned GCP VM no longer exists.");
        ctx.report.step("Enrolling the VM with BB through Google IAP");
        const { hostId } = await bb.experimental_machines.bootstrap({
          key: ctx.key,
          signal: ctx.signal,
          report: ctx.report,
          executor: { exec: (request) => bootstrap(resource, request) },
        });
        if (hostId === resource.controllerHostId)
          throw new Error("The GCP VM cannot be its own power controller.");
        store.attach(ctx.key, hostId);
        touch(hostId);
        return { status: "created", name: resource.instance, resource };
      },
      async suspend(ctx) {
        const resource = resourceSchema.parse(ctx.resource);
        if (resource.controllerHostId === ctx.hostId)
          throw new Error("The controller must run outside the GCP VM.");
        ctx.report.step("Stopping the GCP VM; persistent disks are retained");
        await power(resource, "stop", ctx.signal);
        return { resource };
      },
      async resume(ctx) {
        const resource = resourceSchema.parse(ctx.resource);
        ctx.report.step("Starting the GCP VM");
        if ((await power(resource, "start", ctx.signal)).outcome === "gone")
          throw new Error("The pinned GCP VM no longer exists.");
        ctx.report.step("Restarting the enrolled BB daemon and waiting for connection");
        await restartDaemon(resource, ctx.hostId, ctx.signal, ctx.report);
        return { resource };
      },
      async remove(ctx) {
        const resource = resourceSchema.parse(ctx.resource);
        const pending = store.pendingPower(resource.key);
        if (pending) await power(resource, pending.action, ctx.signal);
        store.release(resource.key);
        ctx.report.step("BB registration removed. The existing VM and its disks are retained.");
        return { status: "removed" };
      },
      async reconcileCleanup(ctx) {
        const binding = store.binding();
        const pending = store.pendingPower(ctx.key);
        if (binding?.resource.key === ctx.key && pending)
          await power(binding.resource, pending.action, ctx.signal);
        store.release(ctx.key);
        return { status: "removed" };
      },
    });
    bb.events.on("experimental_thread.events", ({ thread }) => touchThread(thread));
    bb.events.on("thread.active", ({ thread }) => touchThread(thread));
    bb.events.on("thread.idle", ({ thread }) => touchThread(thread));
    bb.events.on("thread.failed", ({ thread }) => touchThread(thread));
    bb.events.on("experimental_terminal.input", ({ terminal }) => {
      touch(terminal.hostId);
    });
    bb.experimental_hooks.on("message.dispatch", (ctx) => {
      if (ctx.host) touch(ctx.host.id);
      return { action: "proceed" };
    });
    settings.onChange(() => {
      const hostId = store.binding()?.hostId;
      if (hostId) touch(hostId);
    });
    bb.background.schedule("idle-stop", "* * * * *", sweep);
  }
  return {
    register,
    sweep,
    settings,
    async status() {
      const binding = store.binding();
      const config = await settings.get();
      const resource = binding?.resource ?? (await configured("probe").catch(() => null));
      let cloud = null,
        error = lastError;
      if (resource) {
        try {
          cloud = await inspect(resource);
        } catch (cause) {
          error = String(cause);
        }
      }
      const host = binding?.hostId
        ? await bb.sdk.hosts.get({ hostId: binding.hostId, signal: signal() })
        : null;
      return {
        configured: resource !== null,
        hostId: binding?.hostId ?? null,
        autoStop: config.autoStop,
        idleMinutes: 60,
        lastActivityAt: binding?.hostId ? store.lastActivity(binding.hostId) : null,
        idleStatus,
        cloud,
        host,
        error,
      };
    },
    async wake() {
      const binding = store.binding();
      if (!binding?.hostId)
        throw new Error("Enroll the configured VM with the GCP Machine provider first.");
      touch(binding.hostId);
      const host = await bb.sdk.hosts.get({ hostId: binding.hostId, signal: signal() });
      if (host.lifecycle.phase === "active" && host.status !== "connected") {
        const vm = await inspect(binding.resource);
        if (vm.status === "TERMINATED" || vm.status === "RUNNING") {
          const requestSignal = signal(22 * 60_000);
          if ((await power(binding.resource, "start", requestSignal)).outcome === "gone")
            throw new Error("The pinned GCP VM no longer exists.");
          const current = await bb.sdk.hosts.get({ hostId: binding.hostId, signal: requestSignal });
          if (current.lifecycle.phase !== "active")
            throw new Error("The machine lifecycle changed during Wake. Retry after it settles.");
          if (current.status !== "connected")
            await restartDaemon(binding.resource, binding.hostId, requestSignal, {
              step: (message) => bb.log.info(message),
              log() {},
            });
          return bb.sdk.hosts.get({ hostId: binding.hostId, signal: signal() });
        }
        throw new Error(
          `GCP VM is ${vm.status}, but its BB daemon is disconnected. Check the daemon connection before sending work.`,
        );
      }
      return host.lifecycle.phase === "active"
        ? host
        : bb.sdk.hosts.experimental_resume({ hostId: binding.hostId });
    },
  };
}

function target(resource: Resource) {
  return {
    project: resource.project,
    zone: resource.zone,
    instance: resource.instance,
    instanceId: resource.instanceId,
  };
}
export type Service = ReturnType<typeof createService>;
