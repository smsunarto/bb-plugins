import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";

import { parseSeconds } from "../format.ts";
import { pluginSettings } from "../settings.ts";

/** The notification filters and delivery settings. */
export const status = defineQuery({
  output: z.object({
    notifyOnIdle: z.boolean(),
    notifyOnFailed: z.boolean(),
    includeChildThreads: z.boolean(),
    includeHiddenThreads: z.boolean(),
    minRunSeconds: z.number(),
    sound: z.string(),
    agentTool: z.boolean(),
  }),
  execute(ctx) {
    const settings = pluginSettings(ctx.bb);
    return {
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
