import { definePlugin } from "@bb-kit/core/plugin";
import { CHANGED_CHANNEL } from "../shared/contract.ts";
import { latestTurnStore } from "./lib/latest-turn-store.ts";
import {
  captureWorkspace,
  forgetWorkspace,
  hostStalled,
  pinWorkspace,
  resolveTarget,
  settleHost,
  settleOwed,
  snapshotWorkspace,
  type Shot,
  type Target,
} from "./lib/snapshots.ts";
import { latestTurn } from "./rpc/latest-turn.ts";
import { unityContext } from "./rpc/unity-context.ts";

/**
 * The dispatch hook holds bb's server-wide dispatch lock; never hold it longer
 * than this. A baseline still running afterwards proves nothing and is dropped.
 */
const DISPATCH_BUDGET_MS = 1_500;
/** Thread statuses from which a dispatch starts a new turn. */
const STARTABLE = new Set(["pending", "idle", "error"]);
/**
 * bb releases the dispatch lock before a warm turn turns active, so another
 * pass for the thread can run in between. An unclaimed baseline this recent
 * means two passes overlap, and neither can be tied to its turn.
 */
const OVERLAP_MS = 60_000;

/** A proven baseline and the dispatch it was taken for. */
interface Baseline extends Shot {
  text: string;
  rows: ReadonlySet<string>;
}

/** The hook's `input.text` for a queued row: its text blocks, newline-joined. */
function entryText(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export default definePlugin({
  pluginId: "last-turn-diff",
  rpc: { latestTurn, unityContext },
  setup({ bb }) {
    const turns = latestTurnStore(bb);
    const publish = (threadId: string) => bb.realtime.publish(CHANGED_CHANNEL, { threadId });
    const warn = (error: unknown) => bb.log.warn(`workspace snapshot failed: ${String(error)}`);

    // Snapshot operations for one thread run in order, from the moment their
    // event arrives. A turn's dispatch waits for every earlier operation, so
    // a baseline that finished in time proves the previous end did too. Each
    // is a bare host call or local bookkeeping, never another thread's work.
    const queues = new Map<string, Promise<void>>();
    /** When each thread's running operation began. */
    const busySince = new Map<string, number>();
    const enqueue = (threadId: string, operation: () => Promise<void>) => {
      const run = async () => {
        busySince.set(threadId, Date.now());
        try {
          await operation();
        } finally {
          busySince.delete(threadId);
        }
      };
      const next = (queues.get(threadId) ?? Promise.resolve()).then(run).catch(warn);
      queues.set(threadId, next);
      void next.finally(() => {
        if (queues.get(threadId) === next) queues.delete(threadId);
      });
      return next;
    };
    /** A baseline a dispatch proved, waiting for its turn to begin. */
    const pending = new Map<string, Baseline>();
    /** When each thread's current turn opened, or that its end is already pinned. */
    const phase = new Map<string, { openedAt: number } | "ended">();
    const snap = (target: Target, signal?: AbortSignal) =>
      snapshotWorkspace(bb, target, signal).catch(warn);
    const checkoutOf = (thread: { environmentId: string | null }) =>
      resolveTarget(bb, thread).catch(() => null);
    // Scans and settles carry what their host is owed. This reaches the hosts
    // whose checkouts no thread reads again, then retries reads that fell back.
    bb.background.schedule("settle-owed", "*/5 * * * *", async () => {
      await settleOwed(bb);
      await turns.recover();
    });

    /** A proven dispatch baseline also ends the preceding turn. */
    const finish = async (threadId: string, target: Target, shot: Shot) => {
      phase.set(threadId, "ended");
      await pinWorkspace(bb, target, threadId, [{ kind: "end", ...shot }]);
      turns.invalidate(threadId);
    };

    // Baseline the checkout while the dispatch is held, so edits made between
    // turns by the user or other agents stay out of this turn.
    bb.experimental_hooks.on("message.dispatch", async (context) => {
      const { attempt, thread, environment } = context;
      if (
        attempt !== "start-turn" ||
        !STARTABLE.has(thread.status) ||
        environment?.status !== "ready" ||
        !environment.path
      ) {
        return { action: "proceed" };
      }
      const target = { hostId: environment.hostId, environmentPath: environment.path };
      const began = Date.now();
      // An earlier operation that already outlasted the budget, or a host whose
      // last call timed out, leaves no time for a baseline. Let the message go
      // now instead of holding bb's dispatch lock for nothing.
      const since = busySince.get(thread.id);
      if (
        hostStalled(bb, target.hostId) ||
        (since !== undefined && began - since >= DISPATCH_BUDGET_MS)
      ) {
        void enqueue(thread.id, async () => {
          pending.delete(thread.id); // This pass leaves an earlier baseline unclaimable.
        });
        return { action: "proceed" };
      }
      let held = true;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const baseline = enqueue(thread.id, async () => {
        if (!held) {
          pending.delete(thread.id); // This pass leaves an earlier baseline unclaimable.
          return;
        }
        const prior = pending.get(thread.id);
        pending.delete(thread.id);
        const shot = await snap(target, controller.signal);
        if (!held || !shot) return; // The dispatch went ahead without it.
        const current = phase.get(thread.id);
        const opened = typeof current === "object" ? current.openedAt : null;
        // Another admitted pass is still waiting for its turn, or a turn
        // opened no earlier than this pass began. Drop both baselines.
        if ((prior && shot.at - prior.finishedAt < OVERLAP_MS) || (opened ?? -1) >= began) return;
        pending.set(thread.id, {
          ...shot,
          text: context.input.text,
          rows: new Set(context.queuedMessages.map((entry) => entry.id)),
        });
        // The previous turn is over, so this is also its end, and one proven
        // to precede the next turn, unlike a late thread.idle capture.
        if (opened !== null) await finish(thread.id, target, shot);
      });
      const budget = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          held = false;
          controller.abort();
          resolve();
        }, DISPATCH_BUDGET_MS);
      });
      await Promise.race([baseline, budget]);
      clearTimeout(timer);
      return { action: "proceed" };
    });

    // The baselined pass queued its message instead: another plugin or core
    // held it. A Send-now later skips the hook, so the baseline proves nothing.
    bb.events.on("message.queued", ({ entry }) =>
      enqueue(entry.threadId, async () => {
        const baseline = pending.get(entry.threadId);
        if (baseline?.rows.has(entry.id) || baseline?.text === entryText(entry.content)) {
          pending.delete(entry.threadId);
        }
      }),
    );

    // A row the baselined pass did not carry skipped the hook (Send-now): the
    // baseline belongs to some other attempt.
    bb.events.on("message.dispatched", ({ entry }) =>
      enqueue(entry.threadId, async () => {
        if (!pending.get(entry.threadId)?.rows.has(entry.id)) pending.delete(entry.threadId);
      }),
    );

    // The latest completed turn stays the same while a turn runs, so there is
    // nothing to publish; idle refreshes the card.
    bb.events.on("thread.active", async ({ thread }) => {
      turns.invalidate(thread.id);
      await enqueue(thread.id, async () => {
        const baseline = pending.get(thread.id);
        pending.delete(thread.id);
        phase.set(thread.id, { openedAt: Date.now() });
        const target = await checkoutOf(thread);
        if (!target) return;
        await captureWorkspace(bb, target, thread.id, "open", baseline).catch(warn);
        turns.invalidate(thread.id);
      });
    });

    for (const event of ["thread.idle", "thread.failed"] as const) {
      bb.events.on(event, async ({ thread }) => {
        turns.invalidate(thread.id);
        await enqueue(thread.id, async () => {
          if (phase.get(thread.id) !== "ended") {
            const target = await checkoutOf(thread);
            if (target) {
              await captureWorkspace(bb, target, thread.id, "end").catch(warn);
              phase.set(thread.id, "ended");
              turns.invalidate(thread.id);
            }
          }
        });
        // Attribute now, while other threads' captures still bound this turn;
        // RPCs share this result. Outside the queue, so a queued follow-up's
        // dispatch waits only for the bare end capture, never for this scan.
        await turns.read(thread.id).catch(warn);
        publish(thread.id);
      });
    }

    bb.events.on("experimental_thread.events", ({ thread }) => {
      if (thread.status !== "active") publish(thread.id);
    });

    for (const event of ["thread.archived", "thread.deleted"] as const) {
      bb.events.on(event, async ({ thread }) => {
        const forgotten: Target[] = [];
        await enqueue(thread.id, async () => {
          pending.delete(thread.id);
          phase.delete(thread.id);
          turns.invalidate(thread.id);
          const target = await checkoutOf(thread);
          if (!target) return;
          await forgetWorkspace(bb, target, thread.id);
          forgotten.push(target);
        });
        // Delivered outside the thread's queue: a settle waits behind other
        // threads' scans, which a later dispatch must never do.
        for (const { hostId } of forgotten) await settleHost(bb, hostId).catch(() => {});
        publish(thread.id);
      });
    }
  },
});
