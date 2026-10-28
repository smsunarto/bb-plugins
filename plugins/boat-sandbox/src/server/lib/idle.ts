// Idle policy: remember the last bb activity per Boat machine, stop idle ones
// through core, and keep Boat's own auto-stop timer from firing under active
// work. Boat may also stop a sandbox on its own; the sweep converges core to
// that so the machine resumes cleanly instead of sitting disconnected.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { PROVIDER_ID, phaseOf } from "../../shared/constants.ts";
import { readMachineResource, type MachineResource } from "../../shared/schema.ts";
import type { BoatSandbox } from "./boat-api.ts";
import { errorMessage } from "./error-message.ts";
import type { BoatMachine } from "./machine.ts";
import type { SettingsResolution } from "./settings.ts";

export interface IdlePolicyDeps {
  machine: BoatMachine;
  currentSettings(): Promise<SettingsResolution>;
  now(): number;
}

export const IDLE_SWEEP_SCHEDULE = "stop-idle-machines";

/** Thread statuses that occupy a machine, whether or not they emit events. */
const OCCUPYING_THREAD_STATUSES = ["starting", "active"] as const;

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === code
  );
}

type Host = Awaited<ReturnType<BbPluginApi["sdk"]["hosts"]["list"]>>[number];
type IdleSettings = { idleMs: number | null; ttlSeconds: number | null };

export function createIdlePolicy(bb: BbPluginApi, deps: IdlePolicyDeps) {
  const idleKey = (hostId: string) => `idle/${hostId}`;

  async function bump(hostId: string): Promise<void> {
    await bb.storage.kv.set(idleKey(hostId), deps.now());
  }

  async function lastActivity(hostId: string): Promise<number | null> {
    const stored = await bb.storage.kv.get<unknown>(idleKey(hostId));
    return stored === undefined ? null : z.number().finite().parse(stored);
  }

  function owned(host: Host): boolean {
    return host.machineProviderId === PROVIDER_ID && host.lifecycle.phase === "active";
  }

  async function bumpOwned(hostId: string): Promise<void> {
    const host = await bb.sdk.hosts.get({ hostId });
    if (owned(host)) await bump(hostId);
  }

  async function bumpThread(thread: { id: string; environmentId: string | null }): Promise<void> {
    if (thread.environmentId === null) {
      // A thread still provisioning its machine has no environment yet; match it by allocation key.
      for (const host of await bb.sdk.hosts.list()) {
        if (!owned(host)) continue;
        const resource = await bb.experimental_machines.getResource(host.id);
        if (resource !== null && readMachineResource(resource).key === thread.id) {
          await bump(host.id);
          return;
        }
      }
      return;
    }
    const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
    await bumpOwned(environment.hostId);
  }

  /** Threads running on the host right now; a long quiet turn emits no events but still needs the machine. */
  async function occupyingThreads(hostId: string): Promise<number> {
    const counts = await Promise.all(
      OCCUPYING_THREAD_STATUSES.map((status) => bb.sdk.threads.count({ hostId, status })),
    );
    return counts.reduce((sum, count) => sum + count.total, 0);
  }

  /** Ask core to stop the machine; "deferred" means core kept it running for now. */
  async function suspendThroughCore(host: Host, reason: string): Promise<"accepted" | "deferred"> {
    try {
      bb.log.info(`${reason}; asking core to stop ${host.id}`);
      await bb.sdk.hosts.experimental_suspend({ hostId: host.id });
      return "accepted";
    } catch (error) {
      if (hasErrorCode(error, "machine_busy")) return "deferred";
      const current = await bb.sdk.hosts.get({ hostId: host.id }).catch(() => null);
      const phase = current?.lifecycle.phase;
      if (phase === "suspending" || phase === "suspended" || phase === "resuming")
        return "deferred";
      bb.log.warn(`Stopping ${host.id} failed: ${errorMessage(error)}`);
      return "deferred";
    }
  }

  /** Push Boat's auto-stop out while this plugin owns stopping and the machine stays in use. */
  async function keepAlive(
    resource: MachineResource,
    sandbox: BoatSandbox,
    settings: IdleSettings,
  ): Promise<void> {
    if (settings.idleMs === null || settings.ttlSeconds === null) return;
    if (sandbox.archiveAfter === null) return;
    const remainingMs = Date.parse(sandbox.archiveAfter) - deps.now();
    if (Number.isFinite(remainingMs) && remainingMs < (settings.ttlSeconds * 1000) / 2) {
      await deps.machine.extend(resource, settings.ttlSeconds);
      bb.log.info(`Extended Boat auto-stop for ${resource.sandboxId} by ${settings.ttlSeconds} s`);
    }
  }

  async function sweepHost(host: Host, settings: IdleSettings): Promise<void> {
    const stored = await bb.experimental_machines.getResource(host.id);
    if (stored === null) return;
    const resource = readMachineResource(stored);
    const sandbox = await deps.machine.observe(resource);
    const phase = sandbox === null ? "missing" : phaseOf(sandbox.state);
    if (sandbox === null || phase === "gone") {
      bb.log.warn(
        `Boat sandbox ${resource.sandboxId} for ${host.id} is ${phase}; remove the machine`,
      );
      return;
    }
    if (phase === "stopped" || phase === "stopping" || phase === "error") {
      await suspendThroughCore(
        host,
        `Boat reports sandbox ${resource.sandboxId} as ${sandbox.state}`,
      );
      return;
    }
    const last = await lastActivity(host.id);
    if (last === null) {
      await bump(host.id);
    } else if (settings.idleMs !== null && deps.now() >= last + settings.idleMs) {
      if ((await occupyingThreads(host.id)) > 0) {
        await bump(host.id);
      } else {
        const minutes = Math.round(settings.idleMs / 60_000);
        const outcome = await suspendThroughCore(
          host,
          `Machine ${host.id} idle for ${minutes} minutes`,
        );
        if (outcome === "accepted") return;
      }
    }
    // Still running under core: Boat's own timer must not stop it mid-work.
    await keepAlive(resource, sandbox, settings);
  }

  async function sweep(): Promise<void> {
    const resolved = await deps.currentSettings();
    if (!resolved.ok) return;
    for (const host of await bb.sdk.hosts.list()) {
      if (!owned(host)) continue;
      try {
        await sweepHost(host, resolved.settings);
      } catch (error) {
        bb.log.warn(`Idle sweep failed for ${host.id}: ${errorMessage(error)}`);
      }
    }
  }

  bb.events.on("experimental_thread.events", async ({ thread }) => {
    if (thread.status !== "starting" && thread.status !== "active") return;
    await bumpThread(thread);
  });
  bb.events.on("experimental_terminal.input", async ({ terminal }) => {
    await bumpOwned(terminal.hostId);
  });
  bb.background.schedule(IDLE_SWEEP_SCHEDULE, "* * * * *", sweep);

  return { bump, sweep };
}
