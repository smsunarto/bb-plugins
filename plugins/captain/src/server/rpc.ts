import { LADDER_ROLES, type LadderRole } from "../contract/ladder.ts";
import { captainContract, crewOfTag, crewTag, driveTag, LADDERS_TAG } from "../contract/rpc.ts";
import { adoptFromMenu, adoptOptions, crewOf } from "./adopt.ts";
import { resolveAsk } from "./asks.ts";
import type { CommandDeps } from "./commands/deps.ts";
import { listChildren } from "./crew.ts";
import { DEFAULT_LADDERS, roleLadder } from "./ladder.ts";
import { ROLE_SPECS } from "./roles.ts";
import { Refusal } from "./output.ts";
import { startCaptain } from "./commands/new.ts";
import { captainIcons, setCaptainIcon } from "./icon.ts";
import {
  createModelNames,
  createPrimaryHost,
  crewThreads,
  driveFiles,
  watchDrive,
} from "./overview.ts";
import { ensureStorageRoot } from "./commands/deps.ts";
import {
  askItems,
  createCrewReads,
  crewItems,
  deferItem,
  markSeen,
  needsYouCount,
  sinceYouLeft,
} from "./queue.ts";

/** How often a watched banner rechecks the crew for a new or answered interaction. */
export const CREW_POLL_MS = 10_000;

/**
 * The banner's RPCs. Logic lives in `queue.ts` and `asks.ts`, shared with the
 * CLI; this file maps it onto the contract and keeps the reads fresh.
 */
export function registerRpc(deps: CommandDeps, crewPollMs: number = CREW_POLL_MS): void {
  const { bb } = deps;
  const live = (captainId: string) => {
    if (deps.registry.get(captainId) === null)
      throw new Error(`${captainId} is not a live Captain`);
  };
  const modelNames = createModelNames(deps);
  const crewReads = createCrewReads(deps);
  const readCrew = (captainId: string) => crewReads.read(captainId);
  const primaryHost = createPrimaryHost(deps);
  const ladderOf = (role: LadderRole) => ({
    role,
    label: ROLE_SPECS[role].label,
    ...roleLadder(deps.store, role),
    defaults: [...DEFAULT_LADDERS[role]],
  });
  bb.rpc.register(captainContract, {
    ladders: () => ({ roles: LADDER_ROLES.map(ladderOf) }),
    setLadder: ({ role, rungs }) => {
      deps.store.setLadderJson(role, rungs === null ? null : JSON.stringify(rungs), deps.now());
      bb.rpc.experimental_invalidate([LADDERS_TAG]);
      return ladderOf(role);
    },
    captains: () => ({ ids: deps.store.liveCaptains().map((captain) => captain.threadId) }),
    asks: ({ captainId }) => ({ items: askItems(deps, captainId) }),
    crew: async ({ captainId }) => {
      live(captainId);
      return { items: await crewItems(deps, captainId, readCrew) };
    },
    crewThreads: async ({ captainId }) => {
      live(captainId);
      return { threads: await crewThreads(deps, readCrew, modelNames, captainId) };
    },
    drive: ({ captainId }) => {
      live(captainId);
      return driveFiles(deps, primaryHost, captainId);
    },
    sinceYouLeft: ({ captainId }) => {
      live(captainId);
      return sinceYouLeft(deps, captainId);
    },
    resolveAsk: async ({ askId, answer }) => {
      try {
        const { state, notes } = await resolveAsk(deps, askId, answer);
        return { state, warnings: notes };
      } catch (error) {
        if (error instanceof Refusal) throw new Error(error.message, { cause: error });
        throw error;
      }
    },
    defer: ({ captainId, key, action }) => {
      live(captainId);
      return deferItem(deps, captainId, key, action);
    },
    markSeen: ({ captainId, client }) => {
      live(captainId);
      return markSeen(deps, captainId, client);
    },
    needsYou: async ({ keys }) => {
      const ids = [...new Set(keys)];
      const counts = await Promise.all(ids.map((id) => needsYouCount(deps, id)));
      return Object.fromEntries(ids.map((id, index) => [id, counts[index] ?? 0]));
    },
    crewOf: ({ keys }) => crewOf(deps, keys),
    adoptOptions: ({ threadId }) => adoptOptions(deps, threadId),
    adopt: async (input) => {
      try {
        const result = await adoptFromMenu(deps, input);
        crewReads.changed(input.captainId);
        bb.rpc.experimental_invalidate([crewTag(input.captainId), crewOfTag(input.threadId)]);
        return result;
      } catch (error) {
        if (error instanceof Refusal) return { ok: false as const, blockers: error.blockers };
        throw error;
      }
    },
    newCaptain: async ({ name, repos }) => {
      try {
        const started = await startCaptain(deps, { name, repos });
        if (!started.ok) return started;
        const { threadId, state, warnings } = started.captain;
        return { ok: true as const, threadId, state, warnings };
      } catch (error) {
        if (error instanceof Refusal) return { ok: false as const, blockers: error.blockers };
        throw error;
      }
    },
    icons: ({ keys }) => captainIcons(deps, keys),
    captainIcons: () => ({
      captains: deps.store.liveCaptains().map((captain) => ({
        threadId: captain.threadId,
        name: captain.name,
        icon: deps.store.captainIcon(captain.threadId),
      })),
    }),
    // An image refusal's message names why, such as its size; settings shows it as is.
    setIcon: ({ captainId, icon }) => setCaptainIcon(deps, captainId, icon),
  });

  // A watched banner or Overview: bb's thread events cover run states; a new or
  // answered interaction has no event, so the crew list is rechecked while
  // watched. Both reads share one loop per Captain.
  const captainOf = (read: object) => captainOfRead(deps.registry, read);
  const crewWatch = createCrewWatch(deps, crewPollMs, crewReads.changed);
  for (const method of ["crew", "crewThreads"] as const) {
    bb.rpc.experimental_whileWatched(method, (read, signal) => {
      const captainId = captainOf(read);
      return captainId === null ? Promise.resolve() : crewWatch(captainId, signal);
    });
  }

  // A watched Drive refreshes on the filesystem's own change notifications.
  bb.rpc.experimental_whileWatched("drive", (read, signal) => {
    const captainId = captainOf(read);
    if (captainId === null) return Promise.resolve();
    return watchDrive({
      // The storage root may not be read yet when the watch starts.
      resolveDir: async () =>
        (await ensureStorageRoot(deps)) === null ? null : deps.registry.driveDir(captainId),
      signal,
      onChange: () => bb.rpc.experimental_invalidate([driveTag(captainId)]),
      onLive: (live) => deps.registry.setDriveWatched(captainId, live),
      warn: (line) => bb.log.warn(line),
    });
  });

  registerEvents(deps, crewReads.changed);
}

/** The live Captain a watched read names, or null. */
function captainOfRead(registry: CommandDeps["registry"], read: object): string | null {
  if (!("input" in read)) return null;
  const captainId = (read.input as { captainId?: unknown } | null)?.captainId;
  return typeof captainId === "string" && registry.get(captainId) !== null ? captainId : null;
}

/**
 * One crew poll per Captain however many of its reads are watched: the first
 * watcher starts it, the last one to leave stops it. Resolves for each
 * watcher when its own `signal` aborts.
 */
function createCrewWatch(
  deps: CommandDeps,
  crewPollMs: number,
  changed: (captainId: string) => void,
) {
  const { bb } = deps;
  const loops = new Map<string, { watchers: number; stop: AbortController }>();

  async function poll(captainId: string, signal: AbortSignal): Promise<void> {
    let last: string | null = null;
    while (!signal.aborted) {
      try {
        const threads = await listChildren(bb, captainId, false, signal);
        const shape = threads
          .map((thread) => `${thread.id}:${thread.status}:${thread.hasPendingInteraction}`)
          .join(",");
        if (last !== null && shape !== last) {
          changed(captainId);
          bb.rpc.experimental_invalidate([crewTag(captainId)]);
        }
        last = shape;
      } catch (error) {
        if (signal.aborted) return;
        bb.log.warn(`crew watch for ${captainId}: ${(error as Error).message}`);
      }
      await sleep(crewPollMs, signal);
    }
  }

  return (captainId: string, signal: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      if (signal.aborted) return resolve();
      let loop = loops.get(captainId);
      if (loop === undefined) {
        loop = { watchers: 0, stop: new AbortController() };
        loops.set(captainId, loop);
        void poll(captainId, loop.stop.signal);
      }
      loop.watchers += 1;
      const own = loop;
      signal.addEventListener(
        "abort",
        () => {
          own.watchers -= 1;
          if (own.watchers === 0) {
            own.stop.abort();
            if (loops.get(captainId) === own) loops.delete(captainId);
          }
          resolve();
        },
        { once: true },
      );
    });
}

/**
 * Refresh a Captain's crew read when it or one of its children changes run
 * state, or a child starts waiting on an interaction. A thread's crew record
 * is written as it is attached, before its run state or parent next changes,
 * so the same events refresh its row in the thread menus.
 */
function registerEvents(deps: CommandDeps, changed: (captainId: string) => void): void {
  const { bb } = deps;
  const captainOf = (thread: { id: string; parentThreadId: string | null }) =>
    deps.registry.get(thread.id) ?? deps.registry.get(thread.parentThreadId);
  const refresh = ({ thread }: { thread: { id: string; parentThreadId: string | null } }) => {
    const captain = captainOf(thread);
    if (captain !== null) changed(captain.threadId);
    bb.rpc.experimental_invalidate(
      captain === null ? [crewOfTag(thread.id)] : [crewTag(captain.threadId), crewOfTag(thread.id)],
    );
  };
  for (const event of [
    "thread.created",
    "thread.active",
    "thread.idle",
    "thread.failed",
    "thread.archived",
    "thread.unarchived",
    "experimental_thread.parentChanged",
    "interaction.pending",
  ] as const) {
    bb.events.on(event, refresh);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
