import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";

import type { Context } from "../server/context.ts";
import { parseSeconds } from "../server/format.ts";

const statusOutput = z.object({
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
});

/** Whether a BB window is listening, the held count, and the filters. */
export const status = defineQuery({
  output: statusOutput,
  handler: async (context: Context) => {
    const settings = context.settings();
    return {
      listening: context.windowIsListening(),
      polling: context.pollingCount(),
      held: await context.notifications.count(),
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
