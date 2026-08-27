import { defineCommand } from "@bb-kit/core/command";

import { send as sendRpc } from "../rpc/send.ts";

/** Post a fixed sample notification so the user can check the whole path. */
export const test = defineCommand({
  summary: "Post a sample notification to verify the setup",
  async execute(ctx) {
    const input: { message: string; title: string; threadId?: string; projectId?: string } = {
      message: "Notifications are working, even with every BB window closed.",
      title: "bb notify",
    };
    if (ctx.threadId !== undefined) input.threadId = ctx.threadId;
    if (ctx.projectId !== undefined) input.projectId = ctx.projectId;
    const { listening } = await sendRpc.execute(ctx, input);
    return listening
      ? { exitCode: 0, stdout: "Sent through macOS Notification Center.\n" }
      : { exitCode: 1, stdout: "Could not send the macOS notification.\n" };
  },
});
