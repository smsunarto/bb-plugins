import { defineCommand } from "@bb-kit/core/command";

import { send as sendRpc } from "../rpc/send.ts";

export const test = defineCommand({
  summary: "Post a sample notification to verify the setup",
  async execute(ctx) {
    const input: { message: string; title: string; threadId?: string; projectId?: string } = {
      message: "Notifications are working. Click to open this thread.",
      title: "bb notify",
    };
    if (ctx.threadId !== undefined) input.threadId = ctx.threadId;
    if (ctx.projectId !== undefined) input.projectId = ctx.projectId;
    const { listening } = await sendRpc.execute(ctx, input);
    return listening
      ? { exitCode: 0, stdout: "Notification shown by BB.\n" }
      : {
          exitCode: 1,
          stdout: "Notification not shown. Keep a BB desktop window open and check notification permission.\n",
        };
  },
});
