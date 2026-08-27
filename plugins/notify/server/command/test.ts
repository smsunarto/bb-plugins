import { defineCommand } from "@bb-kit/core/command";

import { send as sendRpc } from "../rpc/send.ts";

export const test = defineCommand({
  summary: "Post a sample notification to verify the setup",
  async execute(ctx) {
    const input: { message: string; title: string; projectId?: string } = {
      message: "Notifications are working.",
      title: "bb notify",
    };
    if (ctx.projectId !== undefined) input.projectId = ctx.projectId;
    const { outcome } = await sendRpc.execute(ctx, input);
    if (outcome === "shown") return { exitCode: 0, stdout: "Notification shown by BB.\n" };
    if (outcome === "suppressed") {
      return {
        exitCode: 1,
        stdout: "Notification suppressed. The diagnostic did not create one.\n",
      };
    }
    if (outcome === "failed") {
      return { exitCode: 1, stdout: "Notification not shown. BB could not create it.\n" };
    }
    return {
      exitCode: 1,
      stdout:
        "Notification not shown. Keep a BB desktop window open and check notification permission.\n",
    };
  },
});
