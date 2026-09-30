import { definePlugin } from "@bb-kit/core/plugin";
import { CHANGED_CHANNEL } from "../shared/contract.ts";
import { captureWorkspace, forgetWorkspace, resolveTarget } from "./lib/snapshots.ts";
import { latestTurn } from "./rpc/latest-turn.ts";

/** The dispatch hook holds bb's server-wide dispatch lock; never hold it longer than this. */
const DISPATCH_BUDGET_MS = 1_500;
/** A dispatch capture this recent already opened the turn `thread.active` announces. */
const RECENT_START_MS = 10_000;

export default definePlugin({
  pluginId: "last-turn-diff",
  rpc: { latestTurn },
  setup(bb) {
    const starts = new Map<string, number>();
    const publish = (threadId: string) => bb.realtime.publish(CHANGED_CHANNEL, { threadId });
    const warn = (error: unknown) => bb.log.warn(`workspace snapshot failed: ${String(error)}`);

    // Baseline the checkout before the provider sees the message, so edits made
    // between turns by the user or other agents stay out of this turn.
    bb.experimental_hooks.on("message.dispatch", async ({ attempt, thread, environment }) => {
      if (attempt !== "start-turn" || environment?.status !== "ready" || !environment.path) {
        return { action: "proceed" };
      }
      const at = Date.now();
      starts.set(thread.id, at);
      const target = { hostId: environment.hostId, environmentPath: environment.path };
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        captureWorkspace(bb, target, thread.id, "start", at).catch(warn),
        new Promise((resolve) => (timer = setTimeout(resolve, DISPATCH_BUDGET_MS))),
      ]);
      clearTimeout(timer);
      return { action: "proceed" };
    });

    // A first message dispatches before its environment exists, and Send-now
    // skips the hook. Capture as the turn opens instead.
    bb.events.on("thread.active", async ({ thread }) => {
      if (Date.now() - (starts.get(thread.id) ?? 0) < RECENT_START_MS) return;
      const target = await resolveTarget(bb, thread).catch(() => null);
      if (target) await captureWorkspace(bb, target, thread.id, "start").catch(warn);
      publish(thread.id);
    });

    for (const event of ["thread.idle", "thread.failed"] as const) {
      bb.events.on(event, async ({ thread }) => {
        starts.delete(thread.id);
        const target = await resolveTarget(bb, thread).catch(() => null);
        if (target) await captureWorkspace(bb, target, thread.id, "end").catch(warn);
        publish(thread.id);
      });
    }

    for (const event of ["thread.archived", "thread.deleted"] as const) {
      bb.events.on(event, async ({ thread }) => {
        starts.delete(thread.id);
        const target = await resolveTarget(bb, thread).catch(() => null);
        if (target) await forgetWorkspace(bb, target, thread.id).catch(warn);
        publish(thread.id);
      });
    }
  },
});
