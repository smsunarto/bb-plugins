import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";

import { notificationQueue } from "../delivery.ts";
import { parseSeconds } from "../format.ts";
import { pluginSettings } from "../settings.ts";

/** Whether a BB window is listening, the held count, and the filters. */
export const status = defineQuery({
  output: z.object({
    listening: z.boolean(),
    polling: z.number(),
    held: z.number(),
    notifyOnIdle: z.boolean(),
    notifyOnFailed: z.boolean(),
    includeChildThreads: z.boolean(),
    includeHiddenThreads: z.boolean(),
    minRunSeconds: z.number(),
    sound: z.string(),
    agentTool: z.boolean(),
  }),
  async execute(ctx) {
    const settings = pluginSettings(ctx.bb);
    const snapshot = await notificationQueue(ctx.bb).snapshot();
    return {
      listening: snapshot.listening,
      polling: snapshot.polling,
      held: snapshot.held,
      notifyOnIdle: settings.notifyOnIdle,
      notifyOnFailed: settings.notifyOnFailed,
      includeChildThreads: settings.includeChildThreads,
      includeHiddenThreads: settings.includeHiddenThreads,
      minRunSeconds: parseSeconds(settings.minRunSeconds),
      sound: settings.sound,
      agentTool: settings.agentTool,
    };
  },
});
