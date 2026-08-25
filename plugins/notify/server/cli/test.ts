import { defineCommand, type CommandContext } from "@bb-kit/core/cli";

import { send as sendRpc } from "../rpc/send.ts";
import type { Context } from "@bb-kit/core/plugin";

/** Post a fixed sample notification so the user can check the whole path. */
export const test = defineCommand({
  summary: "Post a sample notification to verify the setup",
  run: async (context: CommandContext<Context>) => {
    const input: { message: string; title: string; threadId?: string; projectId?: string } = {
      message: "Notifications are working. Click to open the thread this came from.",
      title: "bb notify",
    };
    if (context.cli.threadId !== undefined) input.threadId = context.cli.threadId;
    if (context.cli.projectId !== undefined) input.projectId = context.cli.projectId;
    const { listening } = await sendRpc.handler(context, input);
    return listening
      ? { exitCode: 0, stdout: "Queued — a BB window is listening.\n" }
      : { exitCode: 0, stdout: "Held — no BB window is open. It will appear when one is.\n" };
  },
});
