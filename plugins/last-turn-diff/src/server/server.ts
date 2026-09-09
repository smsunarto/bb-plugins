import { definePlugin } from "@bb-kit/core/plugin";
import { CHANGED_CHANNEL } from "../shared/contract.ts";
import { latestTurn } from "./rpc/latest-turn.ts";

export default definePlugin({
  pluginId: "last-turn-diff",
  rpc: { latestTurn },
  setup(bb) {
    // Observe lifecycle events only. This plugin has no agent or message-writing surface.
    for (const event of [
      "thread.active",
      "thread.idle",
      "thread.failed",
      "thread.archived",
      "thread.deleted",
    ] as const) {
      bb.events.on(event, ({ thread }) =>
        bb.realtime.publish(CHANGED_CHANNEL, { threadId: thread.id }),
      );
    }
  },
});
