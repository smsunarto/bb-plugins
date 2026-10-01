import { definePlugin } from "@bb-kit/core/plugin";
import { CHANGED_CHANNEL } from "../shared/contract.ts";
import type { Pin } from "../shared/host-contract.ts";
import { loadLatestTurn } from "./lib/read-latest-turn.ts";
import {
  forgetWorkspace,
  pinWorkspace,
  resolveTarget,
  snapshotWorkspace,
  type Shot,
  type Target,
} from "./lib/snapshots.ts";
import { latestTurn } from "./rpc/latest-turn.ts";

/**
 * The dispatch hook holds bb's server-wide dispatch lock; never hold it longer
 * than this. A baseline still running afterwards proves nothing and is dropped.
 */
const DISPATCH_BUDGET_MS = 1_500;
/** Thread statuses from which a dispatch starts a new turn. */
const STARTABLE = new Set(["pending", "idle", "error"]);

export default definePlugin({
  pluginId: "last-turn-diff",
  rpc: { latestTurn },
  setup(bb) {
    const publish = (threadId: string) => bb.realtime.publish(CHANGED_CHANNEL, { threadId });
    const warn = (error: unknown) => bb.log.warn(`workspace snapshot failed: ${String(error)}`);

    // Snapshot operations for one thread run in order, from the moment their
    // event arrives. A turn's dispatch waits for every earlier operation, so
    // a baseline that finished in time proves the previous end did too.
    const queues = new Map<string, Promise<void>>();
    const enqueue = (threadId: string, operation: () => Promise<void>) => {
      const next = (queues.get(threadId) ?? Promise.resolve()).then(operation).catch(warn);
      queues.set(threadId, next);
      void next.finally(() => {
        if (queues.get(threadId) === next) queues.delete(threadId);
      });
      return next;
    };
    /** A baseline a dispatch proved, waiting for its turn to begin. */
    const pending = new Map<string, Shot>();
    /** Whether each thread's current turn is open or its end is already pinned. */
    const phase = new Map<string, "open" | "ended">();
    const snap = (target: Target) => snapshotWorkspace(bb, target).catch(warn);
    const checkoutOf = (thread: { environmentId: string | null }) =>
      resolveTarget(bb, thread).catch(() => null);

    /** Pin the turn's end; a lifecycle marker even when the snapshot failed. */
    const finish = (threadId: string, target: Target, shot: Shot | null | void) => {
      phase.set(threadId, "ended");
      const now = Date.now();
      const pin: Pin = shot
        ? { kind: "end", ...shot }
        : { kind: "stop", at: now, finishedAt: now, commit: null };
      return pinWorkspace(bb, target, threadId, [pin]);
    };

    // Baseline the checkout while the dispatch is held, so edits made between
    // turns by the user or other agents stay out of this turn.
    bb.experimental_hooks.on("message.dispatch", async ({ attempt, thread, environment }) => {
      if (
        attempt !== "start-turn" ||
        !STARTABLE.has(thread.status) ||
        environment?.status !== "ready" ||
        !environment.path
      ) {
        return { action: "proceed" };
      }
      const target = { hostId: environment.hostId, environmentPath: environment.path };
      let held = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const baseline = enqueue(thread.id, async () => {
        pending.delete(thread.id);
        const shot = await snap(target);
        if (!held || !shot) return; // The dispatch went ahead without it.
        pending.set(thread.id, shot);
        // The previous turn is over, so this is also its end, and one proven
        // to precede the next turn, unlike a late thread.idle capture.
        if (phase.get(thread.id) === "open") await finish(thread.id, target, shot);
      });
      const budget = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          held = false;
          resolve();
        }, DISPATCH_BUDGET_MS);
      });
      await Promise.race([baseline, budget]);
      clearTimeout(timer);
      return { action: "proceed" };
    });

    // The pass queued the message instead: another plugin or core held it. A
    // Send-now later skips the hook, so this baseline proves nothing.
    bb.events.on("message.queued", ({ entry }) =>
      enqueue(entry.threadId, async () => {
        pending.delete(entry.threadId);
      }),
    );

    bb.events.on("thread.active", async ({ thread }) => {
      await enqueue(thread.id, async () => {
        const baseline = pending.get(thread.id);
        pending.delete(thread.id);
        phase.set(thread.id, "open");
        const target = await checkoutOf(thread);
        if (!target) return;
        const shot = await snap(target);
        const pins: Pin[] = [
          ...(baseline ? [{ kind: "start" as const, ...baseline }] : []),
          ...(shot ? [{ kind: "open" as const, ...shot }] : []),
        ];
        if (pins.length > 0) await pinWorkspace(bb, target, thread.id, pins);
      });
      publish(thread.id);
    });

    for (const event of ["thread.idle", "thread.failed"] as const) {
      bb.events.on(event, async ({ thread }) => {
        await enqueue(thread.id, async () => {
          if (phase.get(thread.id) === "ended") return; // The next dispatch already pinned it.
          const target = await checkoutOf(thread);
          if (target) await finish(thread.id, target, await snap(target));
        });
        // Attribute now, while other threads' captures still bound this turn.
        await loadLatestTurn(bb, thread.id).catch(warn);
        publish(thread.id);
      });
    }

    for (const event of ["thread.archived", "thread.deleted"] as const) {
      bb.events.on(event, async ({ thread }) => {
        await enqueue(thread.id, async () => {
          pending.delete(thread.id);
          phase.delete(thread.id);
          const target = await checkoutOf(thread);
          if (target) await forgetWorkspace(bb, target, thread.id);
        });
        publish(thread.id);
      });
    }
  },
});
