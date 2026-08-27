import { defineCommand } from "@bb-kit/core/cli";

import { send as sendRpc } from "../rpc/send.ts";

/** Post a fixed sample notification so the user can check the whole path. */
export const test = defineCommand({
  summary: "Post a sample notification to verify the setup",
  async execute(ctx) {
    const input: { message: string; title: string; threadId?: string; projectId?: string } = {
      message: "Notifications are working. Click to open the thread this came from.",
      title: "bb notify",
    };
    if (ctx.threadId !== undefined) input.threadId = ctx.threadId;
    if (ctx.projectId !== undefined) input.projectId = ctx.projectId;
    const { listening } = await sendRpc.execute(ctx, input);
    return listening
      ? { exitCode: 0, stdout: "Queued — a BB window is listening.\n" }
      : { exitCode: 0, stdout: "Held — no BB window is open. It will appear when one is.\n" };
  },
});
