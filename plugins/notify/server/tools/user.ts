import { defineTool } from "@bb-kit/core/tools";
import { z } from "zod";

import type { Context } from "@bb-kit/core/plugin";
import { deliver } from "../delivery.ts";
import { BODY_MAX_CHARS, oneLine, plainText, threadLabel } from "../format.ts";
import { projectName } from "../project-names.ts";
import { pluginSettings } from "../settings.ts";

export const user = defineTool({
  description:
    "Post a desktop notification on the user's machine. Use it when the user has likely walked away and something needs them now: a long job finished, or you are blocked on a decision. Do not use it for routine progress while they are watching.",
  instructions:
    "notify_user posts a native desktop notification titled with the project and thread. Keep the message under 120 characters, lead with what the user would act on, and write plain prose — markdown syntax is stripped, not rendered.",
  presentation: {
    label: {
      pending: "Notifying the user",
      completed: "Notified the user",
    },
  },
  parameters: z.object({
    message: z.string().min(1).describe("One line the user will act on."),
  }),
  enabled: (ctx: Context) => pluginSettings(ctx.bb).agentTool,
  async execute(ctx, { message }) {
    let heading = "bb";
    let project: string | null = null;
    try {
      const thread = await ctx.bb.sdk.threads.get({ threadId: ctx.tool.threadId });
      heading = threadLabel(thread);
      project = await projectName(ctx.bb, thread.projectId);
    } catch {
      // Thread lookup only supplies labels. Its failure must not block delivery.
    }
    const listening = await deliver(ctx.bb, {
      project,
      heading,
      message: oneLine(plainText(message), BODY_MAX_CHARS),
      threadId: ctx.tool.threadId,
    });
    return listening
      ? "Notification shown by BB."
      : "Notification not shown. Keep a BB desktop window open and check notification permission.";
  },
});
