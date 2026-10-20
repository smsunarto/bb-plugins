import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { gitbutlerHostContract } from "../../shared/host-contract.ts";
import { createMemo, type Memo } from "../../shared/memo.ts";
import type { CheckoutSelection } from "../../shared/schema.ts";
import { knownCheckoutPaths } from "./checkout-paths.ts";

/** bb lost the machine a call was for, named the way the reader knows it. */
export class HostOffline extends Error {
  constructor(hostName: string) {
    super(`${hostName} is not connected.`);
  }
}

/**
 * The client for this plugin's host entry. The environment usually lives on
 * another machine than the bb server, and bb rejects a call to one it lost
 * with a bare "Host is not connected". Such a failure becomes a HostOffline
 * that names the machine. The lookup runs only once a call has failed, so a
 * poll costs no extra round trip.
 */
export function hostClient(bb: BbPluginApi) {
  const client = bb.hosts.experimental_client({ contract: gitbutlerHostContract });
  const call: typeof client.call = async (method, input, options) => {
    try {
      return await client.call(method, input, options);
    } catch (error) {
      const host = await bb.sdk.hosts.get({ hostId: options.hostId }).catch(() => null);
      throw host?.status === "disconnected" ? new HostOffline(host.name) : error;
    }
  };
  return { call };
}

/**
 * How long a repository's origin is trusted. It is how a selected checkout
 * and the other machines' checkouts are recognized, and it rarely changes,
 * so a read of either no longer starts with a call to the main machine.
 */
const ORIGIN_MS = 5 * 60_000;
const origins = new WeakMap<BbPluginApi, Memo>();

/** The canonical path and origin of the repository an environment path names, on its host. */
export function originOf(
  bb: BbPluginApi,
  hostId: string,
  target: { environmentPath: string; repositoryKey?: string },
) {
  let memo = origins.get(bb);
  if (!memo) {
    // A repository without an origin may get one any moment, so that answer is read again.
    memo = createMemo({
      ttlMs: ORIGIN_MS,
      keep: (answer) => (answer as { origin: string | null }).origin !== null,
    });
    origins.set(bb, memo);
  }
  const key = JSON.stringify([hostId, target.environmentPath, target.repositoryKey ?? null]);
  return memo.read(key, () => hostClient(bb).call("origin", target, { hostId }));
}

/** Where a repository is on its host: its key, its path, and its Git directory. */
export type Location = { key: string; path: string; commonDir: string };

/**
 * How long a repository's place on its host is trusted. It rarely moves.
 * Reads of subthread records are keyed by it, and a write that relies on
 * it names it to the host, which refuses the write when the checkout is
 * elsewhere.
 */
const LOCATION_MS = 5 * 60_000;
const locations = new WeakMap<BbPluginApi, Memo>();

function locationMemo(bb: BbPluginApi): Memo {
  let memo = locations.get(bb);
  if (!memo) {
    memo = createMemo({ ttlMs: LOCATION_MS });
    locations.set(bb, memo);
  }
  return memo;
}

function locationKey(target: Target, repositoryKey: string | undefined): string {
  return JSON.stringify([
    target.hostId,
    target.environmentPath,
    target.checkout ? "." : (repositoryKey ?? null),
    target.checkout?.origin ?? null,
  ]);
}

/** Where `target`'s repository is, without a host call once a read has found it. */
export function locationOf(
  bb: BbPluginApi,
  target: Target,
  repositoryKey: string | undefined,
): Promise<Location> {
  return locationMemo(bb).read(locationKey(target, repositoryKey), async () => {
    const { key, identity } = await hostClient(bb).call(
      "checkoutIdentity",
      repositoryTarget(target, repositoryKey),
      { hostId: target.hostId },
    );
    return { key, path: identity.path, commonDir: identity.commonDir };
  });
}

/** Remembers where a board read found its repository, so the next read or write need not ask. */
export function rememberLocation(
  bb: BbPluginApi,
  target: Target,
  repositoryKey: string | undefined,
  location: Location,
): void {
  locationMemo(bb).prime(locationKey(target, repositoryKey), location);
}

/**
 * The panel is always scoped to one thread's environment. Resolution fails
 * for ordinary, explainable reasons — a thread with no project, an
 * environment still starting — so it returns a reason instead of throwing.
 */
export type Target = {
  hostId: string;
  environmentPath: string;
  environmentId: string;
  checkout?: { paths: string[]; origin: string };
};
export type TargetResult = { target: Target; reason: null } | { target: null; reason: string };

export async function resolveTarget(
  bb: BbPluginApi,
  threadId: string,
  checkout?: CheckoutSelection,
  repositoryKey?: string,
): Promise<TargetResult> {
  const thread = await bb.sdk.threads.get({ threadId, include: "environment" });
  const environment = "environment" in thread ? thread.environment : undefined;
  if (!environment) {
    return { target: null, reason: "This thread has no project environment." };
  }
  if (!environment.path) {
    return { target: null, reason: "This thread's environment has no workspace path yet." };
  }
  if (environment.status !== "ready") {
    return { target: null, reason: `This thread's environment is ${environment.status}.` };
  }
  const main: Target = {
    hostId: environment.hostId,
    environmentPath: environment.path,
    environmentId: environment.id,
  };
  if (!checkout) return { target: main, reason: null };
  return { target: await selectedTarget(bb, main, checkout, repositoryKey), reason: null };
}

async function selectedTarget(
  bb: BbPluginApi,
  main: Target,
  checkout: CheckoutSelection,
  repositoryKey?: string,
): Promise<Target> {
  const machines = await knownCheckoutPaths(bb);
  const machine = machines.find(({ host }) => host.id === checkout.hostId);
  if (!machine)
    throw new Error("This checkout's machine is not connected or has no known checkouts.");
  const own = await originOf(bb, main.hostId, repositoryTarget(main, repositoryKey));
  if (!own.origin)
    throw new Error("This repository has no origin to identify its other checkouts.");
  return {
    ...main,
    hostId: checkout.hostId,
    environmentPath: checkout.path,
    checkout: { paths: machine.paths, origin: own.origin },
  };
}

/** A selected checkout already names its repository root; main boards may select a nested repo. */
export function repositoryTarget(target: Target, repositoryKey?: string) {
  return {
    environmentPath: target.environmentPath,
    ...(target.checkout
      ? { checkout: target.checkout, repositoryKey: "." }
      : repositoryKey
        ? { repositoryKey }
        : {}),
  };
}

export const MOVED =
  "This thread moved to another environment since the board was read. Refresh and try again.";

/**
 * The target of a write the reader aimed at a board read in `environmentId`.
 * A branch or a conflict means nothing outside the environment it was read
 * in, so a thread that has moved to another since is refused. Without an
 * environment, as for a read, any target goes.
 */
export async function writeTarget(
  bb: BbPluginApi,
  threadId: string,
  environmentId: string | undefined,
  checkout?: CheckoutSelection,
  repositoryKey?: string,
): Promise<Target> {
  // Pin the thread before any selected-machine or origin lookup.
  const { target: main, reason } = await resolveTarget(bb, threadId);
  if (!main) throw new Error(reason);
  if (environmentId && environmentId !== main.environmentId) throw new Error(MOVED);
  if (!checkout) return main;
  const target = await selectedTarget(bb, main, checkout, repositoryKey);
  const { target: current } = await resolveTarget(bb, threadId);
  if (
    !current ||
    current.environmentId !== main.environmentId ||
    current.hostId !== main.hostId ||
    current.environmentPath !== main.environmentPath
  ) {
    throw new Error(MOVED);
  }
  return target;
}
