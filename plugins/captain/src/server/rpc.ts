import { LADDER_ROLES, type LadderRole } from "../contract/ladder.ts";
import { captainContract, crewTag, LADDERS_TAG } from "../contract/rpc.ts";
import { adoptFromMenu, adoptOptions } from "./adopt.ts";
import { resolveAsk } from "./asks.ts";
import type { CommandDeps } from "./commands/deps.ts";
import { listChildren } from "./crew.ts";
import { DEFAULT_LADDERS, roleLadder } from "./ladder.ts";
import { ROLE_SPECS } from "./roles.ts";
import { Refusal } from "./output.ts";
import { startCaptain } from "./commands/new.ts";
import { askItems, crewItems, deferItem, markSeen, needsYouCount, sinceYouLeft } from "./queue.ts";

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
      return { items: await crewItems(deps, captainId) };
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
    adoptOptions: ({ threadId }) => adoptOptions(deps, threadId),
    adopt: async (input) => {
      try {
        const result = await adoptFromMenu(deps, input);
        if (result.ok) bb.rpc.experimental_invalidate([crewTag(input.captainId)]);
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
  });

  // A watched banner: bb's thread events cover run states; a new or answered
  // interaction has no event, so the crew list is rechecked while watched.
  bb.rpc.experimental_whileWatched("crew", async (read, signal) => {
    if (!("input" in read)) return;
    const captainId = (read.input as { captainId?: unknown }).captainId;
    if (typeof captainId !== "string" || deps.registry.get(captainId) === null) return;
    let last: string | null = null;
    while (!signal.aborted) {
      try {
        const threads = await listChildren(bb, captainId, false, signal);
        const shape = threads
          .map((thread) => `${thread.id}:${thread.status}:${thread.hasPendingInteraction}`)
          .join(",");
        if (last !== null && shape !== last) bb.rpc.experimental_invalidate([crewTag(captainId)]);
        last = shape;
      } catch (error) {
        if (signal.aborted) return;
        bb.log.warn(`banner crew watch for ${captainId}: ${(error as Error).message}`);
      }
      await sleep(crewPollMs, signal);
    }
  });

  registerEvents(deps);
}

/**
 * Refresh a Captain's crew read when it or one of its children changes run
 * state, or a child starts waiting on an interaction.
 */
function registerEvents(deps: CommandDeps): void {
  const { bb } = deps;
  const captainOf = (thread: { id: string; parentThreadId: string | null }) =>
    deps.registry.get(thread.id) ?? deps.registry.get(thread.parentThreadId);
  const refresh = ({ thread }: { thread: { id: string; parentThreadId: string | null } }) => {
    const captain = captainOf(thread);
    if (captain !== null) bb.rpc.experimental_invalidate([crewTag(captain.threadId)]);
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
