// The notify_user agent tool: a deliberate interruption an agent can send
// when the user has likely walked away. Posts through the context directly —
// the same path as an event notification.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { BODY_MAX_CHARS, type Context } from "./context.ts";
import { oneLine, plainText, threadLabel } from "./format.ts";

export function registerAgentTool(bb: BbPluginApi, context: Context): void {
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
    // No title parameter: the heading is always `<project> · <thread>`, the
    // same as an event notification. An agent-supplied headline would make
    // one row of the notification list look unlike all the others, and it is
    // information the reader already has.
    parameters: z.object({
      message: z.string().min(1).describe("One line the user will act on."),
    }),
    async execute({ message }, ctx) {
      let heading = "bb";
      let project: string | null = null;
      try {
        const thread = await bb.sdk.threads.get({ threadId: ctx.threadId });
        heading = threadLabel(thread);
        project = await context.projectName(thread.projectId);
      } catch {
        // Thread lookup is decoration only — still send the notification.
      }
      const listening = await context.post(
        project,
        heading,
        oneLine(plainText(message), BODY_MAX_CHARS),
        ctx.threadId,
      );
      return listening
        ? "Notification queued; a BB window is listening."
        : "No BB window is open; the notification will appear when one is.";
    },
  });

  bb.agents.configure(() => ({
    tools: context.settings().agentTool ? ["notify_user"] : [],
    skills: [],
  }));
}
