import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { deliver } from "./delivery.ts";
import { BODY_MAX_CHARS, oneLine, plainText, threadLabel } from "./format.ts";
import { projectName } from "./project-names.ts";
import { pluginSettings } from "./settings.ts";

export function registerAgentTool(bb: BbPluginApi): void {
  bb.agents.registerTool({
    name: "notify_user",
    description:
      "Post a desktop notification on the user's machine. Use it when the user has likely walked away and something needs them now: a long job finished, or you are blocked on a decision. Do not use it for routine progress while they are watching.",
    instructions:
      "notify_user posts a native desktop notification titled with the project and thread. Keep the message under 120 characters, lead with what the user would act on, and write plain prose — markdown syntax is stripped, not rendered.",
    experimental_statusLabels: {
      pending: "Notifying the user",
      completed: "Notified the user",
    },
    parameters: z.object({
      message: z.string().min(1).describe("One line the user will act on."),
    }),
    async execute({ message }, ctx) {
      let heading = "bb";
      let project: string | null = null;
      try {
        const thread = await bb.sdk.threads.get({ threadId: ctx.threadId });
        heading = threadLabel(thread);
        project = await projectName(bb, thread.projectId);
      } catch {
        // Thread lookup is decoration only — still send the notification.
      }
      const listening = await deliver(bb, {
        project,
        heading,
        message: oneLine(plainText(message), BODY_MAX_CHARS),
        threadId: ctx.threadId,
      });
      return listening
        ? "Notification queued; a BB window is listening."
        : "No BB window is open; the notification will appear when one is.";
    },
  });

  bb.agents.configure(() => ({
    tools: pluginSettings(bb).agentTool ? ["notify_user"] : [],
    skills: [],
  }));
}
