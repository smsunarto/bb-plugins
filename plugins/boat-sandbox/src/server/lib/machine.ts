// The Boat machine provider: allocate a sandbox for a bb machine key, hand
// core an executor to install its daemon, and stop, resume and delete the
// sandbox later. Every operation reads Boat's current state first, so a retry
// after a crash finds nothing left to do.
import type { BbPluginApi, MachineExecutor, PluginKvStorage } from "@get-bb/plugin-sdk";
import type {
  PluginMachineProviderCreateContext,
  PluginMachineProviderLifecycleContext,
  PluginMachineProviderProgress,
  PluginMachineProviderResource,
} from "@get-bb/plugin-sdk/machine-provider";
import { z } from "zod";
import {
  PROVIDER_ID,
  phaseOf,
  type SandboxPhase,
  type SandboxType,
} from "../../shared/constants.ts";
import {
  machineInputsSchema,
  readMachineResource,
  type ConnectionStatus,
  type LaunchOptions,
  type MachineInputs,
  type MachineInspection,
  type MachineResource,
} from "../../shared/schema.ts";
import {
  isBoatApiError,
  withBoatRetry,
  type BoatClient,
  type BoatClientFactory,
  type BoatSandbox,
} from "./boat-api.ts";
import { errorMessage } from "./error-message.ts";
import { createBoatExecutor } from "./executor.ts";
import type { ResolvedSettings, SettingsResolution } from "./settings.ts";

export interface BoatMachineDeps {
  clientFactory: BoatClientFactory;
  /** Remembers which account each allocation was requested from, before Boat answers. */
  kv: PluginKvStorage;
  currentSettings(): Promise<SettingsResolution>;
  now(): number;
  sleep(delayMs: number): Promise<void>;
  randomId(): string;
}

export interface BoatMachine {
  register(bb: BbPluginApi, options: { onConnected(hostId: string): Promise<void> }): void;
  connectionStatus(): Promise<ConnectionStatus>;
  launchOptions(): Promise<LaunchOptions>;
  inspect(resource: MachineResource): Promise<MachineInspection>;
  /** Boat's view of a machine's sandbox, or null when Boat no longer has it. */
  observe(resource: MachineResource): Promise<BoatSandbox | null>;
  /** Move Boat's auto-stop deadline to now plus the configured TTL. */
  extend(resource: MachineResource, ttlSeconds: number): Promise<void>;
  close(): void;
}

type ResourceLifecycleContext = PluginMachineProviderLifecycleContext & {
  hostId: string;
  resource: PluginMachineProviderResource;
};

const POLL_MS = 2_000;
const READY_TIMEOUT_MS = 10 * 60_000;
const STOP_TIMEOUT_MS = 15 * 60_000;
const DELETE_TIMEOUT_MS = 2 * 60_000;
const ICON = "./assets/icon.svg";

/** Where an allocation was requested, kept from before the create call until cleanup finishes. */
const allocationSchema = z.object({
  accountIdentity: z.string().min(1),
  apiBase: z.string().min(1),
});
const allocationKey = (key: string) => `allocations/${key}`;

export const MACHINE_DEFINITION = {
  id: PROVIDER_ID,
  displayName: "Boat Sandbox",
  description: "Create a sandbox in your Boat account.",
  environmentDescription: "Create a project checkout in a new Boat sandbox.",
  icon: ICON,
} as const;

const tokenOf = (settings: ResolvedSettings) => `${settings.apiBase}\n${settings.apiKey}`;

function missing(sandboxId: string): Error {
  return new Error(
    `Boat sandbox ${sandboxId} is missing: it was deleted outside bb, so there is nothing to resume. Remove the machine.`,
  );
}

function throwIfTerminal(sandbox: BoatSandbox, phase: SandboxPhase): void {
  if (phase === "gone") {
    throw new Error(
      `Boat cancelled sandbox ${sandbox.id}: ${sandbox.error ?? "no machine was available"}`,
    );
  }
  if (phase === "error") {
    throw new Error(`Boat sandbox ${sandbox.id} is in error: ${sandbox.error ?? "unknown cause"}`);
  }
}

function stuck(sandbox: BoatSandbox, timeoutMs: number, stopError: string | null): Error {
  const minutes = Math.round(timeoutMs / 60_000);
  const detail = stopError === null ? "" : `; the last stop attempt failed: ${stopError}`;
  return new Error(
    `Boat sandbox ${sandbox.id} stayed ${sandbox.state} for ${minutes} minutes${detail}`,
  );
}

export function createBoatMachine(deps: BoatMachineDeps): BoatMachine {
  let cached: { token: string; client: BoatClient } | null = null;
  /** Account identity per credentials: a key belongs to one account, so it is read once. */
  const identities = new Map<string, string>();

  async function requireSettings(): Promise<ResolvedSettings> {
    const resolved = await deps.currentSettings();
    if (!resolved.ok) throw new Error(resolved.message);
    return resolved.settings;
  }

  function clientFor(settings: ResolvedSettings): BoatClient {
    const token = tokenOf(settings);
    if (cached?.token === token) return cached.client;
    const client = deps.clientFactory({ apiBase: settings.apiBase, apiKey: settings.apiKey });
    cached = { token, client };
    return client;
  }

  async function currentAccount(settings: ResolvedSettings, signal?: AbortSignal) {
    const client = clientFor(settings);
    const token = tokenOf(settings);
    const known = identities.get(token);
    if (known !== undefined) return { client, identity: known };
    const identity = (await client.account(signal)).identity;
    identities.set(token, identity);
    return { client, identity };
  }

  /** The client for a machine's pinned account; another account's key must not touch it. */
  async function pinnedClient(resource: MachineResource, signal?: AbortSignal) {
    const settings = await requireSettings();
    const { client, identity } = await currentAccount(settings, signal);
    if (identity !== resource.accountIdentity) {
      throw new Error("Restore the machine's pinned Boat account before lifecycle operations.");
    }
    return { client, settings };
  }

  async function delay(signal: AbortSignal): Promise<void> {
    await deps.sleep(POLL_MS);
    signal.throwIfAborted();
  }

  /** Poll until the sandbox reaches one of `phases`; a terminal state outside them is an error. */
  async function waitForPhase(
    client: BoatClient,
    sandboxId: string,
    phases: readonly SandboxPhase[],
    options: { signal: AbortSignal; timeoutMs: number; report: PluginMachineProviderProgress },
  ): Promise<BoatSandbox> {
    const deadline = deps.now() + options.timeoutMs;
    let reportedStopError: string | null = null;
    for (;;) {
      const sandbox = await client.get(sandboxId, options.signal);
      if (sandbox === null) throw missing(sandboxId);
      const phase = phaseOf(sandbox.state);
      if (phases.includes(phase)) return sandbox;
      throwIfTerminal(sandbox, phase);
      const stopError = sandbox.stop?.status === "failing" ? sandbox.stop.error : null;
      if (stopError !== null && stopError !== reportedStopError) {
        reportedStopError = stopError;
        options.report.log(`Boat could not save the disk yet and is retrying: ${stopError}\n`);
      }
      if (deps.now() >= deadline) throw stuck(sandbox, options.timeoutMs, stopError);
      await delay(options.signal);
    }
  }

  /**
   * Find the sandbox allocated for `key`, or create it. The label lookup covers an attempt whose
   * create response was lost; the idempotency key only guards the retries of this one call, and is
   * fresh per call so Boat never replays a sandbox that cleanup has since deleted.
   */
  async function allocate(
    client: BoatClient,
    settings: ResolvedSettings,
    context: { key: string; signal: AbortSignal; accountIdentity: string },
    selection: { type: SandboxType; from: string | null },
  ): Promise<BoatSandbox> {
    const existing = (await client.listByKey(context.key, context.signal)).find(
      (sandbox) => phaseOf(sandbox.state) !== "gone",
    );
    if (existing !== undefined) return existing;
    // Durable before the request leaves: cleanup must search this account even if the response is lost.
    await deps.kv.set(allocationKey(context.key), {
      accountIdentity: context.accountIdentity,
      apiBase: settings.apiBase,
    });
    const request = {
      key: context.key,
      idempotencyKey: `bb-machine-${context.key}-${deps.randomId()}`,
      name: `bb ${context.key.slice(-8)}`,
      type: selection.type,
      from: selection.from,
      environment: settings.environment,
      ttlSeconds: settings.ttlSeconds,
    };
    return withBoatRetry("idempotent", () => client.create(request, context.signal), {
      signal: context.signal,
      sleep: deps.sleep,
    });
  }

  /** Ask Boat to resume; a 409 means it is already running or on its way back, which the wait decides. */
  async function bringBack(
    client: BoatClient,
    sandboxId: string,
    settings: ResolvedSettings,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await withBoatRetry(
        "idempotent",
        () => client.resume(sandboxId, settings.ttlSeconds, signal),
        {
          signal,
          sleep: deps.sleep,
        },
      );
    } catch (error) {
      if (!isBoatApiError(error, 409)) throw error;
    }
  }

  /** Boat deletes in the background after its 202; wait until the key lists nothing live. */
  async function waitForGone(client: BoatClient, key: string, signal: AbortSignal): Promise<void> {
    const deadline = deps.now() + DELETE_TIMEOUT_MS;
    for (;;) {
      const remaining = (await client.listByKey(key, signal)).filter(
        (sandbox) => phaseOf(sandbox.state) !== "gone",
      );
      if (remaining.length === 0) return;
      if (deps.now() >= deadline) {
        throw new Error(
          `Boat still lists ${remaining.length} sandbox(es) for this machine after ${Math.round(DELETE_TIMEOUT_MS / 60_000)} minutes; retry cleanup.`,
        );
      }
      await delay(signal);
    }
  }

  async function create(
    context: PluginMachineProviderCreateContext<typeof machineInputsSchema>,
  ): Promise<{ resource: MachineResource; executor: MachineExecutor }> {
    const settings = await requireSettings();
    const client = clientFor(settings);
    const inputs: MachineInputs = machineInputsSchema.parse(context.inputs);
    const selection = { type: inputs.type ?? settings.defaultType, from: inputs.from ?? null };
    const { identity } = await currentAccount(settings, context.signal);
    context.signal.throwIfAborted();
    context.report.step(
      selection.from === null
        ? `Creating a ${selection.type} Boat sandbox…`
        : `Creating a ${selection.type} Boat sandbox from ${selection.from}…`,
    );
    const sandbox = await allocate(
      client,
      settings,
      { key: context.key, signal: context.signal, accountIdentity: identity },
      selection,
    );
    const resource: MachineResource = {
      key: context.key,
      sandboxId: sandbox.id,
      accountIdentity: identity,
      type: sandbox.type ?? selection.type,
      from: selection.from,
      environment: settings.environment,
    };
    await context.checkpoint(resource);
    context.signal.throwIfAborted();
    let phase = phaseOf(sandbox.state);
    if (phase === "stopping") {
      // A previous attempt stopped this sandbox and Boat is still saving its disk.
      context.report.step(`Waiting for Boat sandbox ${sandbox.id} to finish stopping…`);
      const settled = await waitForPhase(client, sandbox.id, ["stopped", "error"], {
        signal: context.signal,
        timeoutMs: STOP_TIMEOUT_MS,
        report: context.report,
      });
      phase = phaseOf(settled.state);
    }
    if (phase === "stopped" || phase === "error") {
      // A previous attempt got as far as stopping this sandbox: bring it back instead of allocating twice.
      context.report.step(`Resuming Boat sandbox ${sandbox.id}…`);
      await bringBack(client, sandbox.id, settings, context.signal);
    }
    context.report.step("Waiting for the sandbox to be ready…");
    const ready = await waitForPhase(client, sandbox.id, ["running"], {
      signal: context.signal,
      timeoutMs: READY_TIMEOUT_MS,
      report: context.report,
    });
    context.report.log(`Boat sandbox ${ready.id} (${resource.type}) is ready\n`);
    return { resource, executor: createBoatExecutor(client, ready.id, deps) };
  }

  async function suspend(context: ResourceLifecycleContext): Promise<MachineResource> {
    const resource = readMachineResource(context.resource);
    const { client } = await pinnedClient(resource, context.signal);
    const sandbox = await client.get(resource.sandboxId, context.signal);
    if (sandbox === null) throw missing(resource.sandboxId);
    const phase = phaseOf(sandbox.state);
    if (phase === "starting" || phase === "running") {
      context.report.step("Stopping the Boat sandbox; its disk is saved first…");
      await client.stop(resource.sandboxId, context.signal);
    }
    if (phase !== "stopped" && phase !== "error") {
      await waitForPhase(client, resource.sandboxId, ["stopped", "error"], {
        signal: context.signal,
        timeoutMs: STOP_TIMEOUT_MS,
        report: context.report,
      });
    }
    context.report.log(
      `Boat sandbox ${resource.sandboxId} is stopped; resume restores its newest snapshot\n`,
    );
    await context.checkpoint(resource);
    return resource;
  }

  async function resume(
    context: ResourceLifecycleContext,
  ): Promise<{ resource: MachineResource; executor: MachineExecutor }> {
    const resource = readMachineResource(context.resource);
    const { client, settings } = await pinnedClient(resource, context.signal);
    const sandbox = await client.get(resource.sandboxId, context.signal);
    if (sandbox === null) throw missing(resource.sandboxId);
    if (sandbox.dataExpiredAt !== null) {
      throw new Error(
        `Boat deleted the disk of sandbox ${resource.sandboxId} on ${sandbox.dataExpiredAt}, 14 days after it stopped; it cannot resume. Remove the machine.`,
      );
    }
    const phase = phaseOf(sandbox.state);
    if (phase === "stopped" || phase === "stopping" || phase === "error") {
      context.report.step("Resuming the Boat sandbox from its newest snapshot…");
      await bringBack(client, resource.sandboxId, settings, context.signal);
    }
    await context.checkpoint(resource);
    context.report.step("Waiting for the sandbox to be ready…");
    await waitForPhase(client, resource.sandboxId, ["running"], {
      signal: context.signal,
      timeoutMs: READY_TIMEOUT_MS,
      report: context.report,
    });
    return { resource, executor: createBoatExecutor(client, resource.sandboxId, deps) };
  }

  return {
    register(bb, options) {
      bb.experimental_environments.register({
        id: MACHINE_DEFINITION.id,
        displayName: MACHINE_DEFINITION.displayName,
        description: MACHINE_DEFINITION.environmentDescription,
        icon: MACHINE_DEFINITION.icon,
        machineProviderId: MACHINE_DEFINITION.id,
        environmentProviderId: "project-checkout",
      });
      bb.experimental_machines.register({
        id: MACHINE_DEFINITION.id,
        displayName: MACHINE_DEFINITION.displayName,
        description: MACHINE_DEFINITION.description,
        icon: MACHINE_DEFINITION.icon,
        ephemeral: true,
        inputs: machineInputsSchema,
        async availability() {
          const resolved = await deps.currentSettings();
          return resolved.ok
            ? { status: "available" }
            : { status: "setup-required", message: resolved.message };
        },
        validate({ inputs }) {
          const parsed = machineInputsSchema.safeParse(inputs);
          return parsed.success
            ? { action: "accept" }
            : {
                action: "refuse",
                message: parsed.error.issues.map((issue) => issue.message).join("; "),
              };
        },
        async create(context) {
          try {
            const created = await create(context);
            context.signal.throwIfAborted();
            const connectStartedAt = deps.now();
            const { hostId } = await bb.experimental_machines.bootstrap({
              key: context.key,
              executor: created.executor,
              report: context.report,
              signal: context.signal,
            });
            context.report.log(`Boat daemon connected in ${deps.now() - connectStartedAt} ms\n`);
            context.signal.throwIfAborted();
            await options.onConnected(hostId);
            return {
              status: "created",
              name: `Boat ${created.resource.sandboxId}`,
              resource: created.resource,
            };
          } catch (error) {
            context.signal.throwIfAborted();
            return { status: "failed", message: errorMessage(error) };
          }
        },
        async reconcileCleanup(context) {
          try {
            const settings = await requireSettings();
            const { client, identity } = await currentAccount(settings, context.signal);
            const stored = await deps.kv.get<unknown>(allocationKey(context.key));
            if (stored !== undefined) {
              // Only the allocating account can see its sandboxes; another account would find nothing and call that clean.
              const allocation = allocationSchema.parse(stored);
              if (
                allocation.accountIdentity !== identity ||
                allocation.apiBase !== settings.apiBase
              ) {
                throw new Error(
                  "This machine was allocated through another Boat account or API base; restore that configuration before cleanup.",
                );
              }
            }
            const live = (await client.listByKey(context.key, context.signal)).filter(
              (sandbox) => phaseOf(sandbox.state) !== "gone",
            );
            for (const sandbox of live) {
              context.signal.throwIfAborted();
              context.report.log(
                `Deleting Boat sandbox ${sandbox.id} allocated for this machine\n`,
              );
              await client.delete(sandbox.id, context.signal);
            }
            await waitForGone(client, context.key, context.signal);
            await deps.kv.delete(allocationKey(context.key));
            return { status: "removed" };
          } catch (error) {
            context.signal.throwIfAborted();
            return { status: "failed", message: errorMessage(error) };
          }
        },
        async suspend(context) {
          return { resource: await suspend(context) };
        },
        async resume(context) {
          const resumed = await resume(context);
          await bb.experimental_machines.bootstrap({
            key: resumed.resource.key,
            executor: resumed.executor,
            report: context.report,
            signal: context.signal,
          });
          await options.onConnected(context.hostId);
          return { resource: resumed.resource };
        },
        async remove(context) {
          try {
            const resource = readMachineResource(context.resource);
            const { client } = await pinnedClient(resource, context.signal);
            context.report.log(`Deleting Boat sandbox ${resource.sandboxId} and its snapshots\n`);
            await client.delete(resource.sandboxId, context.signal);
            await deps.kv.delete(allocationKey(resource.key));
            return { status: "removed" };
          } catch (error) {
            context.signal.throwIfAborted();
            return { status: "failed", message: errorMessage(error) };
          }
        },
      });
    },
    async connectionStatus() {
      const resolved = await deps.currentSettings();
      if (!resolved.ok) return { available: false, message: resolved.message };
      try {
        const account = await clientFor(resolved.settings).account();
        const usage =
          account.activeSandboxes !== null && account.maxActiveSandboxes !== null
            ? `, ${account.activeSandboxes} of ${account.maxActiveSandboxes} sandboxes running`
            : "";
        return {
          available: true,
          message: `Connected to Boat as ${account.login || "an API key"}${usage}`,
        };
      } catch (error) {
        return { available: false, message: errorMessage(error) };
      }
    },
    async launchOptions() {
      const settings = await requireSettings();
      const client = clientFor(settings);
      const [types, snapshots] = await Promise.all([
        client.machineTypes(),
        client.savedSnapshots(),
      ]);
      return { defaultType: settings.defaultType, types, snapshots };
    },
    async observe(resource) {
      const { client } = await pinnedClient(resource);
      return client.get(resource.sandboxId);
    },
    async extend(resource, ttlSeconds) {
      const { client } = await pinnedClient(resource);
      await client.extend(resource.sandboxId, ttlSeconds);
    },
    async inspect(resource) {
      const sandbox = await this.observe(resource);
      const phase = sandbox === null ? "missing" : phaseOf(sandbox.state);
      const state = phase === "gone" ? "missing" : phase;
      const archiveAfter =
        sandbox?.archiveAfter === null || sandbox?.archiveAfter === undefined
          ? null
          : Date.parse(sandbox.archiveAfter);
      const dataExpired = sandbox?.dataExpiredAt !== null && sandbox?.dataExpiredAt !== undefined;
      const summary =
        state === "missing"
          ? `Boat sandbox ${resource.sandboxId} is missing; it was deleted outside bb and cannot be recovered.`
          : dataExpired
            ? `Boat sandbox ${resource.sandboxId} is stopped and its disk expired; it cannot resume.`
            : state === "error"
              ? `Boat sandbox ${resource.sandboxId} is in error (${sandbox?.error ?? "unknown cause"}); resume restores its newest snapshot.`
              : `Boat sandbox ${resource.sandboxId} is ${state}.`;
      return {
        summary,
        values: {
          state,
          sandboxId: resource.sandboxId,
          type: sandbox?.type ?? resource.type,
          archiveAfter: Number.isFinite(archiveAfter) ? archiveAfter : null,
          hydrated: sandbox?.hydrated ?? null,
          dataExpired,
        },
      };
    },
    close() {
      cached = null;
      identities.clear();
    },
  };
}
