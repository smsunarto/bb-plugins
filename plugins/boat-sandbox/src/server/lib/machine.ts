// The Boat machine provider: allocate a sandbox for a bb machine key, hand
// core an executor to install its daemon, and stop, resume and delete the
// sandbox later. Every operation reads Boat's current state first, so a retry
// after a crash finds nothing left to do.
import type { PluginRuntime } from "@bb-plugins/effect-bridge";
import type { BbPluginApi, PluginKvStorage } from "@get-bb/plugin-sdk";
import type {
  PluginMachineProviderCreateContext,
  PluginMachineProviderLifecycleContext,
  PluginMachineProviderProgress,
  PluginMachineProviderResource,
} from "@get-bb/plugin-sdk/machine-provider";
import { Cache, Cause, Clock, Context, Duration, Effect, Exit, Layer, Schedule } from "effect";
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
  retryBoat,
  type BoatClient,
  type BoatClientFactory,
  type BoatCredentials,
  type BoatSandbox,
} from "./boat-api.ts";
import { call } from "./call.ts";
import { errorMessage } from "./error-message.ts";
import { createBoatExecutor } from "./executor.ts";
import type { ResolvedSettings, SettingsResolution } from "./settings.ts";

export interface BoatMachineDeps {
  clientFactory: BoatClientFactory;
  /** Remembers which account each allocation was requested from, before Boat answers. */
  kv: PluginKvStorage;
  currentSettings(): Promise<SettingsResolution>;
  randomId(): string;
}

type ResourceLifecycleContext = PluginMachineProviderLifecycleContext & {
  hostId: string;
  resource: PluginMachineProviderResource;
};
type ProgressContext = { report: PluginMachineProviderProgress };

/** A sandbox ready to run commands, through the client of the account it belongs to. */
interface ReadySandbox {
  resource: MachineResource;
  client: BoatClient;
}

const POLL_MS = 2_000;
const READY_TIMEOUT_MS = 10 * 60_000;
const STOP_TIMEOUT_MS = 15 * 60_000;
const DELETE_TIMEOUT_MS = 2 * 60_000;
/** Distinct API keys seen while the plugin is loaded; in practice one. */
const IDENTITY_CAPACITY = 16;
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

const credentialsOf = (settings: ResolvedSettings): BoatCredentials => ({
  apiBase: settings.apiBase,
  apiKey: settings.apiKey,
});

function missing(sandboxId: string): Error {
  return new Error(
    `Boat sandbox ${sandboxId} is missing: it was deleted outside bb, so there is nothing to resume. Remove the machine.`,
  );
}

function terminalError(sandbox: BoatSandbox, phase: SandboxPhase): Error | null {
  if (phase === "gone") {
    return new Error(
      `Boat cancelled sandbox ${sandbox.id}: ${sandbox.error ?? "no machine was available"}`,
    );
  }
  if (phase === "error") {
    return new Error(`Boat sandbox ${sandbox.id} is in error: ${sandbox.error ?? "unknown cause"}`);
  }
  return null;
}

const stopErrorOf = (sandbox: BoatSandbox) =>
  sandbox.stop?.status === "failing" ? sandbox.stop.error : null;

function stuck(sandbox: BoatSandbox, timeoutMs: number, stopError: string | null): Error {
  const minutes = Math.round(timeoutMs / 60_000);
  const detail = stopError === null ? "" : `; the last stop attempt failed: ${stopError}`;
  return new Error(
    `Boat sandbox ${sandbox.id} stayed ${sandbox.state} for ${minutes} minutes${detail}`,
  );
}

/** Poll every 2 s for `timeoutMs`; the caller decides what the last observation means. */
const pollFor = (timeoutMs: number) =>
  Schedule.spaced(POLL_MS).pipe(Schedule.upTo({ duration: timeoutMs }));

/** Poll until the sandbox reaches one of `phases`; a terminal state outside them is an error. */
const waitForPhase = Effect.fnUntraced(function* (
  client: BoatClient,
  sandboxId: string,
  phases: readonly SandboxPhase[],
  options: { timeoutMs: number; report: PluginMachineProviderProgress },
) {
  const reached = (sandbox: BoatSandbox) => phases.includes(phaseOf(sandbox.state));
  let reportedStopError: string | null = null;
  const observe = Effect.gen(function* () {
    const sandbox = yield* call((signal) => client.get(sandboxId, signal));
    if (sandbox === null) return yield* Effect.fail(missing(sandboxId));
    if (reached(sandbox)) return sandbox;
    const terminal = terminalError(sandbox, phaseOf(sandbox.state));
    if (terminal !== null) return yield* Effect.fail(terminal);
    const stopError = stopErrorOf(sandbox);
    if (stopError !== null && stopError !== reportedStopError) {
      reportedStopError = stopError;
      options.report.log(`Boat could not save the disk yet and is retrying: ${stopError}\n`);
    }
    return sandbox;
  });
  const last = yield* Effect.repeat(observe, {
    schedule: pollFor(options.timeoutMs),
    until: reached,
  });
  if (reached(last)) return last;
  return yield* Effect.fail(stuck(last, options.timeoutMs, stopErrorOf(last)));
});

/** Ask Boat to resume; a 409 means it is already running or on its way back, which the wait decides. */
const bringBack = (client: BoatClient, sandboxId: string, settings: ResolvedSettings) =>
  retryBoat("idempotent")(
    call((signal) => client.resume(sandboxId, settings.ttlSeconds, signal)),
  ).pipe(
    Effect.catchIf(
      (error) => isBoatApiError(error, 409),
      () => Effect.void,
    ),
  );

/** Boat deletes in the background after its 202; wait until the key lists nothing live. */
const waitForGone = Effect.fnUntraced(function* (client: BoatClient, key: string) {
  const observe = call((signal) => client.listByKey(key, signal)).pipe(
    Effect.map((sandboxes) => sandboxes.filter((sandbox) => phaseOf(sandbox.state) !== "gone")),
  );
  const remaining = yield* Effect.repeat(observe, {
    schedule: pollFor(DELETE_TIMEOUT_MS),
    until: (live) => live.length === 0,
  });
  if (remaining.length === 0) return;
  return yield* Effect.fail(
    new Error(
      `Boat still lists ${remaining.length} sandbox(es) for this machine after ${Math.round(DELETE_TIMEOUT_MS / 60_000)} minutes; retry cleanup.`,
    ),
  );
});

export class BoatMachine extends Context.Service<
  BoatMachine,
  {
    readonly connectionStatus: Effect.Effect<ConnectionStatus, unknown>;
    readonly launchOptions: Effect.Effect<LaunchOptions, unknown>;
    inspect(resource: MachineResource): Effect.Effect<MachineInspection, unknown>;
    /** Boat's view of a machine's sandbox, or null when Boat no longer has it. */
    observe(resource: MachineResource): Effect.Effect<BoatSandbox | null, unknown>;
    /** Move Boat's auto-stop deadline to now plus the configured TTL. */
    extend(resource: MachineResource, ttlSeconds: number): Effect.Effect<void, unknown>;
    create(
      context: PluginMachineProviderCreateContext<typeof machineInputsSchema>,
    ): Effect.Effect<ReadySandbox, unknown>;
    suspend(context: ResourceLifecycleContext): Effect.Effect<MachineResource, unknown>;
    resume(context: ResourceLifecycleContext): Effect.Effect<ReadySandbox, unknown>;
    reconcileCleanup(context: ProgressContext & { key: string }): Effect.Effect<void, unknown>;
    remove(
      context: ProgressContext & { resource: PluginMachineProviderResource },
    ): Effect.Effect<void, unknown>;
  }
>()("boat-sandbox/BoatMachine") {
  static readonly layer = (deps: BoatMachineDeps) => Layer.effect(BoatMachine, make(deps));
}

const make = Effect.fnUntraced(function* (deps: BoatMachineDeps) {
  let cached: { token: string; client: BoatClient } | null = null;

  function clientFor(credentials: BoatCredentials): BoatClient {
    const token = `${credentials.apiBase}\n${credentials.apiKey}`;
    if (cached?.token === token) return cached.client;
    const client = deps.clientFactory(credentials);
    cached = { token, client };
    return client;
  }

  /**
   * Account identity per credentials: a key belongs to one account, so it is read once, and calls
   * that start together share the read. A failed read is not kept.
   */
  const identities = yield* Cache.makeWith(
    (credentials: BoatCredentials) =>
      call((signal) => clientFor(credentials).account(signal)).pipe(
        Effect.map((account) => account.identity),
      ),
    {
      capacity: IDENTITY_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
    },
  );

  const requireSettings = call(() => deps.currentSettings()).pipe(
    Effect.flatMap((resolved) =>
      resolved.ok ? Effect.succeed(resolved.settings) : Effect.fail(new Error(resolved.message)),
    ),
  );

  const currentAccount = (settings: ResolvedSettings) =>
    Cache.get(identities, credentialsOf(settings)).pipe(
      Effect.map((identity) => ({ client: clientFor(credentialsOf(settings)), identity })),
    );

  /** The client for a machine's pinned account; another account's key must not touch it. */
  const pinnedClient = Effect.fnUntraced(function* (resource: MachineResource) {
    const settings = yield* requireSettings;
    const { client, identity } = yield* currentAccount(settings);
    if (identity !== resource.accountIdentity) {
      return yield* Effect.fail(
        new Error("Restore the machine's pinned Boat account before lifecycle operations."),
      );
    }
    return { client, settings };
  });

  /**
   * Find the sandbox allocated for `key`, or create it. The label lookup covers an attempt whose
   * create response was lost; the idempotency key only guards the retries of this one call, and is
   * fresh per call so Boat never replays a sandbox that cleanup has since deleted.
   */
  const allocate = Effect.fnUntraced(function* (
    client: BoatClient,
    settings: ResolvedSettings,
    context: { key: string; accountIdentity: string },
    selection: { type: SandboxType; from: string | null },
  ) {
    const existing = (yield* call((signal) => client.listByKey(context.key, signal))).find(
      (sandbox) => phaseOf(sandbox.state) !== "gone",
    );
    if (existing !== undefined) return existing;
    // Durable before the request leaves: cleanup must search this account even if the response is lost.
    yield* call(() =>
      deps.kv.set(allocationKey(context.key), {
        accountIdentity: context.accountIdentity,
        apiBase: settings.apiBase,
      }),
    );
    const request = {
      key: context.key,
      idempotencyKey: `bb-machine-${context.key}-${deps.randomId()}`,
      name: `bb ${context.key.slice(-8)}`,
      type: selection.type,
      from: selection.from,
      environment: settings.environment,
      ttlSeconds: settings.ttlSeconds,
    };
    return yield* retryBoat("idempotent")(call((signal) => client.create(request, signal)));
  });

  const observe = Effect.fnUntraced(function* (resource: MachineResource) {
    const { client } = yield* pinnedClient(resource);
    return yield* call((signal) => client.get(resource.sandboxId, signal));
  });

  return BoatMachine.of({
    connectionStatus: Effect.gen(function* () {
      const resolved = yield* call(() => deps.currentSettings());
      if (!resolved.ok) return { available: false, message: resolved.message };
      return yield* call((signal) =>
        clientFor(credentialsOf(resolved.settings)).account(signal),
      ).pipe(
        Effect.map((account) => {
          const usage =
            account.activeSandboxes !== null && account.maxActiveSandboxes !== null
              ? `, ${account.activeSandboxes} of ${account.maxActiveSandboxes} sandboxes running`
              : "";
          return {
            available: true,
            message: `Connected to Boat as ${account.login || "an API key"}${usage}`,
          };
        }),
        Effect.catch((error) => Effect.succeed({ available: false, message: errorMessage(error) })),
      );
    }),

    launchOptions: Effect.gen(function* () {
      const settings = yield* requireSettings;
      const client = clientFor(credentialsOf(settings));
      const [types, snapshots] = yield* Effect.all(
        [
          call((signal) => client.machineTypes(signal)),
          call((signal) => client.savedSnapshots(signal)),
        ],
        { concurrency: "unbounded" },
      );
      return { defaultType: settings.defaultType, types, snapshots };
    }),

    observe,

    extend: Effect.fnUntraced(function* (resource, ttlSeconds) {
      const { client } = yield* pinnedClient(resource);
      yield* call((signal) => client.extend(resource.sandboxId, ttlSeconds, signal));
    }),

    inspect: Effect.fnUntraced(function* (resource): Effect.fn.Return<MachineInspection, unknown> {
      const sandbox = yield* observe(resource);
      const phase = sandbox === null ? "gone" : phaseOf(sandbox.state);
      if (sandbox === null || phase === "gone") {
        return {
          state: "missing",
          sandboxId: resource.sandboxId,
          summary: `Boat sandbox ${resource.sandboxId} is missing; it was deleted outside bb and cannot be recovered.`,
        };
      }
      const dataExpired = sandbox.dataExpiredAt !== null;
      const archiveAfter = sandbox.archiveAfter === null ? null : Date.parse(sandbox.archiveAfter);
      return {
        state: phase,
        sandboxId: resource.sandboxId,
        type: sandbox.type ?? resource.type,
        archiveAfter: Number.isFinite(archiveAfter) ? archiveAfter : null,
        hydrated: sandbox.hydrated,
        dataExpired,
        error: sandbox.error,
        summary: dataExpired
          ? `Boat sandbox ${resource.sandboxId} is stopped and its disk expired; it cannot resume.`
          : phase === "error"
            ? `Boat sandbox ${resource.sandboxId} is in error (${sandbox.error ?? "unknown cause"}); resume restores its newest snapshot.`
            : `Boat sandbox ${resource.sandboxId} is ${phase}.`,
      };
    }),

    create: Effect.fn("BoatMachine.create")(function* (context) {
      const settings = yield* requireSettings;
      const client = clientFor(credentialsOf(settings));
      const inputs: MachineInputs = machineInputsSchema.parse(context.inputs);
      const selection = { type: inputs.type ?? settings.defaultType, from: inputs.from ?? null };
      const { identity } = yield* currentAccount(settings);
      context.report.step(
        selection.from === null
          ? `Creating a ${selection.type} Boat sandbox…`
          : `Creating a ${selection.type} Boat sandbox from ${selection.from}…`,
      );
      const sandbox = yield* allocate(
        client,
        settings,
        { key: context.key, accountIdentity: identity },
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
      yield* call(() => context.checkpoint(resource));
      let phase = phaseOf(sandbox.state);
      if (phase === "stopping") {
        // A previous attempt stopped this sandbox and Boat is still saving its disk.
        context.report.step(`Waiting for Boat sandbox ${sandbox.id} to finish stopping…`);
        const settled = yield* waitForPhase(client, sandbox.id, ["stopped", "error"], {
          timeoutMs: STOP_TIMEOUT_MS,
          report: context.report,
        });
        phase = phaseOf(settled.state);
      }
      if (phase === "stopped" || phase === "error") {
        // A previous attempt got as far as stopping this sandbox: bring it back instead of allocating twice.
        context.report.step(`Resuming Boat sandbox ${sandbox.id}…`);
        yield* bringBack(client, sandbox.id, settings);
      }
      context.report.step("Waiting for the sandbox to be ready…");
      const ready = yield* waitForPhase(client, sandbox.id, ["running"], {
        timeoutMs: READY_TIMEOUT_MS,
        report: context.report,
      });
      context.report.log(`Boat sandbox ${ready.id} (${resource.type}) is ready\n`);
      return { resource, client };
    }),

    suspend: Effect.fn("BoatMachine.suspend")(function* (context) {
      const resource = readMachineResource(context.resource);
      const { client } = yield* pinnedClient(resource);
      const sandbox = yield* call((signal) => client.get(resource.sandboxId, signal));
      if (sandbox === null) return yield* Effect.fail(missing(resource.sandboxId));
      const phase = phaseOf(sandbox.state);
      if (phase === "starting" || phase === "running") {
        context.report.step("Stopping the Boat sandbox; its disk is saved first…");
        yield* call((signal) => client.stop(resource.sandboxId, signal));
      }
      if (phase !== "stopped" && phase !== "error") {
        yield* waitForPhase(client, resource.sandboxId, ["stopped", "error"], {
          timeoutMs: STOP_TIMEOUT_MS,
          report: context.report,
        });
      }
      context.report.log(
        `Boat sandbox ${resource.sandboxId} is stopped; resume restores its newest snapshot\n`,
      );
      yield* call(() => context.checkpoint(resource));
      return resource;
    }),

    resume: Effect.fn("BoatMachine.resume")(function* (context) {
      const resource = readMachineResource(context.resource);
      const { client, settings } = yield* pinnedClient(resource);
      const sandbox = yield* call((signal) => client.get(resource.sandboxId, signal));
      if (sandbox === null) return yield* Effect.fail(missing(resource.sandboxId));
      if (sandbox.dataExpiredAt !== null) {
        return yield* Effect.fail(
          new Error(
            `Boat deleted the disk of sandbox ${resource.sandboxId} on ${sandbox.dataExpiredAt}, 14 days after it stopped; it cannot resume. Remove the machine.`,
          ),
        );
      }
      const phase = phaseOf(sandbox.state);
      if (phase === "stopped" || phase === "stopping" || phase === "error") {
        context.report.step("Resuming the Boat sandbox from its newest snapshot…");
        yield* bringBack(client, resource.sandboxId, settings);
      }
      yield* call(() => context.checkpoint(resource));
      context.report.step("Waiting for the sandbox to be ready…");
      yield* waitForPhase(client, resource.sandboxId, ["running"], {
        timeoutMs: READY_TIMEOUT_MS,
        report: context.report,
      });
      return { resource, client };
    }),

    reconcileCleanup: Effect.fn("BoatMachine.reconcileCleanup")(function* (context) {
      const settings = yield* requireSettings;
      const { client, identity } = yield* currentAccount(settings);
      const stored = yield* call(() => deps.kv.get<unknown>(allocationKey(context.key)));
      if (stored !== undefined) {
        // Only the allocating account can see its sandboxes; another account would find nothing and call that clean.
        const allocation = allocationSchema.parse(stored);
        if (allocation.accountIdentity !== identity || allocation.apiBase !== settings.apiBase) {
          return yield* Effect.fail(
            new Error(
              "This machine was allocated through another Boat account or API base; restore that configuration before cleanup.",
            ),
          );
        }
      }
      const live = (yield* call((signal) => client.listByKey(context.key, signal))).filter(
        (sandbox) => phaseOf(sandbox.state) !== "gone",
      );
      for (const sandbox of live) {
        context.report.log(`Deleting Boat sandbox ${sandbox.id} allocated for this machine\n`);
        yield* call((signal) => client.delete(sandbox.id, signal));
      }
      yield* waitForGone(client, context.key);
      yield* call(() => deps.kv.delete(allocationKey(context.key)));
    }),

    remove: Effect.fn("BoatMachine.remove")(function* (context) {
      const resource = readMachineResource(context.resource);
      const { client } = yield* pinnedClient(resource);
      context.report.log(`Deleting Boat sandbox ${resource.sandboxId} and its snapshots\n`);
      yield* call((signal) => client.delete(resource.sandboxId, signal));
      yield* call(() => deps.kv.delete(allocationKey(resource.key)));
    }),
  });
});

/**
 * A failed create, cleanup or removal is an answer to core, not a rejection; a cancelled one is
 * interrupted, so `run` rejects with the abort reason.
 */
const orFailed = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.succeed({ status: "failed" as const, message: errorMessage(Cause.squash(cause)) }),
    ),
  );

export function registerBoatMachine(
  bb: BbPluginApi,
  options: {
    machine: BoatMachine["Service"];
    run: PluginRuntime<never>["run"];
    randomId(): string;
    currentSettings(): Promise<SettingsResolution>;
    onConnected(hostId: string): Effect.Effect<void, unknown>;
  },
): void {
  const { machine, run } = options;
  const bootstrap = (
    key: string,
    ready: ReadySandbox,
    context: Pick<PluginMachineProviderLifecycleContext, "report" | "signal">,
  ) =>
    call(() =>
      bb.experimental_machines.bootstrap({
        key,
        executor: createBoatExecutor(ready.client, ready.resource.sandboxId, {
          randomId: options.randomId,
          run,
        }),
        report: context.report,
        signal: context.signal,
      }),
    );

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
      const resolved = await options.currentSettings();
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
    create: (context) =>
      run(
        Effect.gen(function* () {
          const ready = yield* machine.create(context);
          const connectStartedAt = yield* Clock.currentTimeMillis;
          const { hostId } = yield* bootstrap(context.key, ready, context);
          const connectedAt = yield* Clock.currentTimeMillis;
          context.report.log(`Boat daemon connected in ${connectedAt - connectStartedAt} ms\n`);
          yield* options.onConnected(hostId);
          return {
            status: "created" as const,
            name: `Boat ${ready.resource.sandboxId}`,
            resource: ready.resource,
          };
        }).pipe(orFailed),
        context.signal,
      ),
    reconcileCleanup: (context) =>
      run(
        machine.reconcileCleanup(context).pipe(Effect.as({ status: "removed" as const }), orFailed),
        context.signal,
      ),
    suspend: (context) =>
      run(machine.suspend(context).pipe(Effect.map((resource) => ({ resource }))), context.signal),
    resume: (context) =>
      run(
        Effect.gen(function* () {
          const ready = yield* machine.resume(context);
          yield* bootstrap(ready.resource.key, ready, context);
          yield* options.onConnected(context.hostId);
          return { resource: ready.resource };
        }),
        context.signal,
      ),
    remove: (context) =>
      run(
        machine.remove(context).pipe(Effect.as({ status: "removed" as const }), orFailed),
        context.signal,
      ),
  });
}
