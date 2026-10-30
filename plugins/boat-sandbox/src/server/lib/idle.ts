// Idle policy: remember the last bb activity per Boat machine, stop idle ones
// through core, and keep Boat's own auto-stop timer from firing under active
// work. Boat may also stop a sandbox on its own; the sweep converges core to
// that so the machine resumes cleanly instead of sitting disconnected.
import type { PluginRuntime } from "@bb-plugins/effect-bridge";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { Cause, Clock, Context, Effect, Fiber, FiberMap, Layer, Predicate } from "effect";
import { z } from "zod";
import { PROVIDER_ID, phaseOf } from "../../shared/constants.ts";
import { readMachineResource, type MachineResource } from "../../shared/schema.ts";
import { REQUEST_TIMEOUT_MS, type BoatSandbox } from "./boat-api.ts";
import { call } from "./call.ts";
import { errorMessage } from "./error-message.ts";
import { BoatMachine } from "./machine.ts";
import type { SettingsResolution } from "./settings.ts";

export const IDLE_SWEEP_SCHEDULE = "stop-idle-machines";

/** Thread statuses that occupy a machine, whether or not they emit events. */
const OCCUPYING_THREAD_STATUSES = ["starting", "active"] as const;
/** Hosts swept at once; each makes a few Boat calls, far below Boat's 1,000 requests a minute. */
const SWEEP_CONCURRENCY = 4;
/**
 * How long the sweep waits for one host. bb runs every plugin's schedules in turn, so a slow host
 * must not hold them up; its calls still finish, and the host is swept again once they have.
 */
const HOST_SWEEP_WAIT_MS = REQUEST_TIMEOUT_MS;

const hasErrorCode = (error: unknown, code: string): boolean =>
  error instanceof Error && Predicate.hasProperty(error, "code") && error.code === code;

type Host = Awaited<ReturnType<BbPluginApi["sdk"]["hosts"]["list"]>>[number];
type IdleSettings = { idleMs: number | null; ttlSeconds: number | null };
type Thread = { id: string; environmentId: string | null };

export class IdlePolicy extends Context.Service<
  IdlePolicy,
  {
    /** Record bb activity on a host now. */
    bump(hostId: string): Effect.Effect<void, unknown>;
    bumpThread(thread: Thread): Effect.Effect<void, unknown>;
    bumpOwned(hostId: string): Effect.Effect<void, unknown>;
    readonly sweep: Effect.Effect<void, unknown>;
  }
>()("boat-sandbox/IdlePolicy") {
  static readonly layer = (bb: BbPluginApi, currentSettings: () => Promise<SettingsResolution>) =>
    Layer.effect(IdlePolicy, make(bb, currentSettings));
}

const make = Effect.fnUntraced(function* (
  bb: BbPluginApi,
  currentSettings: () => Promise<SettingsResolution>,
) {
  const machine = yield* BoatMachine;
  /** Each host's sweep until its calls settle, so a call that hangs is never sent a second time. */
  const sweeps = yield* FiberMap.make<string>();
  const idleKey = (hostId: string) => `idle/${hostId}`;

  const bump = Effect.fnUntraced(function* (hostId: string) {
    const now = yield* Clock.currentTimeMillis;
    yield* call(() => bb.storage.kv.set(idleKey(hostId), now));
  });

  const lastActivity = (hostId: string) =>
    call(() => bb.storage.kv.get<unknown>(idleKey(hostId))).pipe(
      Effect.map((stored) => (stored === undefined ? null : z.number().finite().parse(stored))),
    );

  function owned(host: Host): boolean {
    return host.machineProviderId === PROVIDER_ID && host.lifecycle.phase === "active";
  }

  const bumpOwned = Effect.fnUntraced(function* (hostId: string) {
    const host = yield* call(() => bb.sdk.hosts.get({ hostId }));
    if (owned(host)) yield* bump(hostId);
  });

  const bumpThread = Effect.fnUntraced(function* (thread: Thread) {
    if (thread.environmentId === null) {
      // A thread still provisioning its machine has no environment yet; match it by allocation key.
      for (const host of yield* call(() => bb.sdk.hosts.list())) {
        if (!owned(host)) continue;
        const resource = yield* call(() => bb.experimental_machines.getResource(host.id));
        if (resource !== null && readMachineResource(resource).key === thread.id) {
          yield* bump(host.id);
          return;
        }
      }
      return;
    }
    const { environmentId } = thread;
    const environment = yield* call(() => bb.sdk.environments.get({ environmentId }));
    yield* bumpOwned(environment.hostId);
  });

  /** Threads running on the host right now; a long quiet turn emits no events but still needs the machine. */
  const occupyingThreads = (hostId: string) =>
    Effect.all(
      OCCUPYING_THREAD_STATUSES.map((status) =>
        call(() => bb.sdk.threads.count({ hostId, status })),
      ),
      { concurrency: "unbounded" },
    ).pipe(Effect.map((counts) => counts.reduce((sum, count) => sum + count.total, 0)));

  /** Ask core to stop the machine; "deferred" means core kept it running for now. */
  const suspendThroughCore = Effect.fnUntraced(function* (
    host: Host,
    reason: string,
  ): Effect.fn.Return<"accepted" | "deferred"> {
    yield* Effect.logInfo(`${reason}; asking core to stop ${host.id}`);
    return yield* call(() => bb.sdk.hosts.experimental_suspend({ hostId: host.id })).pipe(
      Effect.as("accepted" as const),
      Effect.catch((error) =>
        Effect.gen(function* () {
          if (hasErrorCode(error, "machine_busy")) return "deferred" as const;
          const current = yield* call(() => bb.sdk.hosts.get({ hostId: host.id })).pipe(
            Effect.orElseSucceed(() => null),
          );
          const phase = current?.lifecycle.phase;
          if (phase === "suspending" || phase === "suspended" || phase === "resuming")
            return "deferred" as const;
          yield* Effect.logWarning(`Stopping ${host.id} failed: ${errorMessage(error)}`);
          return "deferred" as const;
        }),
      ),
    );
  });

  /** Push Boat's auto-stop out while this plugin owns stopping and the machine stays in use. */
  const keepAlive = Effect.fnUntraced(function* (
    resource: MachineResource,
    sandbox: BoatSandbox,
    settings: IdleSettings,
  ) {
    if (settings.idleMs === null || settings.ttlSeconds === null) return;
    if (sandbox.archiveAfter === null) return;
    const remainingMs = Date.parse(sandbox.archiveAfter) - (yield* Clock.currentTimeMillis);
    if (Number.isFinite(remainingMs) && remainingMs < (settings.ttlSeconds * 1000) / 2) {
      yield* machine.extend(resource, settings.ttlSeconds);
      yield* Effect.logInfo(
        `Extended Boat auto-stop for ${resource.sandboxId} by ${settings.ttlSeconds} s`,
      );
    }
  });

  const sweepHost = Effect.fnUntraced(function* (host: Host, settings: IdleSettings) {
    const stored = yield* call(() => bb.experimental_machines.getResource(host.id));
    if (stored === null) return;
    const resource = readMachineResource(stored);
    const sandbox = yield* machine.observe(resource);
    const phase = sandbox === null ? "missing" : phaseOf(sandbox.state);
    if (sandbox === null || phase === "gone") {
      yield* Effect.logWarning(
        `Boat sandbox ${resource.sandboxId} for ${host.id} is ${phase}; remove the machine`,
      );
      return;
    }
    if (phase === "stopped" || phase === "stopping" || phase === "error") {
      yield* suspendThroughCore(
        host,
        `Boat reports sandbox ${resource.sandboxId} as ${sandbox.state}`,
      );
      return;
    }
    const last = yield* lastActivity(host.id);
    if (last === null) {
      yield* bump(host.id);
    } else if (
      settings.idleMs !== null &&
      (yield* Clock.currentTimeMillis) >= last + settings.idleMs
    ) {
      if ((yield* occupyingThreads(host.id)) > 0) {
        yield* bump(host.id);
      } else {
        const minutes = Math.round(settings.idleMs / 60_000);
        const outcome = yield* suspendThroughCore(
          host,
          `Machine ${host.id} idle for ${minutes} minutes`,
        );
        if (outcome === "accepted") return;
      }
    }
    // Still running under core: Boat's own timer must not stop it mid-work.
    yield* keepAlive(resource, sandbox, settings);
  });

  /** Sweep one host, unless its sweep from an earlier run is still waiting on a call. */
  const sweepOnce = Effect.fnUntraced(function* (host: Host, settings: IdleSettings) {
    if (yield* FiberMap.has(sweeps, host.id)) return;
    const fiber = yield* FiberMap.run(
      sweeps,
      host.id,
      sweepHost(host, settings).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning(
                `Idle sweep failed for ${host.id}: ${errorMessage(Cause.squash(cause))}`,
              ),
        ),
      ),
    );
    yield* Fiber.await(fiber).pipe(
      Effect.timeoutOrElse({
        duration: HOST_SWEEP_WAIT_MS,
        orElse: () =>
          Effect.logWarning(
            `Idle sweep for ${host.id} is still waiting on Boat or bb after ${HOST_SWEEP_WAIT_MS / 1000} s; later sweeps skip it until that call settles`,
          ),
      }),
    );
  });

  const sweep = Effect.gen(function* () {
    const resolved = yield* call(() => currentSettings());
    if (!resolved.ok) return;
    const hosts = (yield* call(() => bb.sdk.hosts.list())).filter(owned);
    yield* Effect.forEach(hosts, (host) => sweepOnce(host, resolved.settings), {
      concurrency: SWEEP_CONCURRENCY,
      discard: true,
    });
  });

  return IdlePolicy.of({ bump, bumpThread, bumpOwned, sweep });
});

export function registerIdlePolicy(
  bb: BbPluginApi,
  policy: IdlePolicy["Service"],
  run: PluginRuntime<never>["run"],
): void {
  bb.events.on("experimental_thread.events", async ({ thread }) => {
    if (thread.status !== "starting" && thread.status !== "active") return;
    await run(policy.bumpThread(thread));
  });
  bb.events.on("experimental_terminal.input", async ({ terminal }) => {
    await run(policy.bumpOwned(terminal.hostId));
  });
  bb.background.schedule(IDLE_SWEEP_SCHEDULE, "* * * * *", () => run(policy.sweep));
}
