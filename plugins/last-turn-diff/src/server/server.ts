import { definePlugin } from "@bb-kit/core/plugin";
import { CHANGED_CHANNEL } from "../shared/contract.ts";
import type { CaptureKind } from "../shared/host-contract.ts";
import { captureWorkspace, forgetWorkspace, resolveTarget, type Target } from "./lib/snapshots.ts";
import { latestTurn } from "./rpc/latest-turn.ts";

/**
 * The dispatch hook holds bb's server-wide dispatch lock; never hold it longer
 * than this. A capture still running afterwards finishes too late to count as
 * the turn's baseline, and the host discards it.
 */
const DISPATCH_BUDGET_MS = 1_500;

export default definePlugin({
  pluginId: "last-turn-diff",
  rpc: { latestTurn },
  setup(bb) {
    const publish = (threadId: string) => bb.realtime.publish(CHANGED_CHANNEL, { threadId });
    const warn = (error: unknown) => bb.log.warn(`workspace snapshot failed: ${String(error)}`);

    // Snapshot operations for one thread run in order, so a forget can never
    // land before a capture that would recreate the thread's refs.
    const queues = new Map<string, Promise<void>>();
    const enqueue = (threadId: string, operation: () => Promise<void>) => {
      const next = (queues.get(threadId) ?? Promise.resolve()).then(operation).catch(warn);
      queues.set(threadId, next);
      void next.finally(() => {
        if (queues.get(threadId) === next) queues.delete(threadId);
      });
      return next;
    };
    // Stamp the capture when it actually starts, not when it was queued.
    const capture = (threadId: string, target: Target, kind: CaptureKind) =>
      enqueue(threadId, () => captureWorkspace(bb, target, threadId, kind, Date.now()));
    const checkoutOf = (thread: { environmentId: string | null }) =>
      resolveTarget(bb, thread).catch(() => null);

    // Baseline the checkout before the provider sees the message, so edits made
    // between turns by the user or other agents stay out of this turn.
    bb.experimental_hooks.on("message.dispatch", async ({ attempt, thread, environment }) => {
      if (attempt !== "start-turn" || environment?.status !== "ready" || !environment.path) {
        return { action: "proceed" };
      }
      const checkout = { hostId: environment.hostId, environmentPath: environment.path };
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        capture(thread.id, checkout, "start"),
        new Promise((resolve) => (timer = setTimeout(resolve, DISPATCH_BUDGET_MS))),
      ]);
      clearTimeout(timer);
      return { action: "proceed" };
    });

    // The turn is really running now; a dispatch baseline may have been queued
    // by another plugin instead. This capture also baselines turns that never
    // passed the hook: a first message before its environment, or Send-now.
    bb.events.on("thread.active", async ({ thread }) => {
      const checkout = await checkoutOf(thread);
      if (checkout) await capture(thread.id, checkout, "open");
      publish(thread.id);
    });

    for (const event of ["thread.idle", "thread.failed"] as const) {
      bb.events.on(event, async ({ thread }) => {
        const checkout = await checkoutOf(thread);
        if (checkout) await capture(thread.id, checkout, "end");
        publish(thread.id);
      });
    }

    for (const event of ["thread.archived", "thread.deleted"] as const) {
      bb.events.on(event, async ({ thread }) => {
        const checkout = await checkoutOf(thread);
        if (checkout) await enqueue(thread.id, () => forgetWorkspace(bb, checkout, thread.id));
        publish(thread.id);
      });
    }
  },
});
