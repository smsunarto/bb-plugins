import { argv, defineCommand } from "@bb-kit/core/command";
import { z } from "zod";

import { send as sendRpc } from "../rpc/send.ts";
import { isThreadId } from "../format.ts";

export const send = defineCommand({
  summary: "Post a notification",
  input: z.object({
    message: argv.words(z.string().min(1), {
      fallbackOption: true,
      description: "notification text (markdown is stripped)",
    }),
    title: argv.option(z.string().optional(), {
      description: "heading shown instead of bb",
    }),
    thread: argv.option(z.string().refine(isThreadId, "not a thread id").optional(), {
      description: "thread the notification opens",
    }),
  }),
  async execute(ctx, { message, title, thread }) {
    const input: { message: string; title?: string; threadId?: string; projectId?: string } = {
      message,
    };
    if (title !== undefined) input.title = title;
    const threadId = thread ?? ctx.threadId;
    if (threadId !== undefined) input.threadId = threadId;
    if (thread === undefined && ctx.projectId !== undefined) {
      input.projectId = ctx.projectId;
    }
    const { listening } = await sendRpc.execute(ctx, input);
    return listening
      ? { exitCode: 0, stdout: "Notification shown by BB.\n" }
      : {
          exitCode: 1,
          stdout: "Notification not shown. Keep a BB desktop window open and check notification permission.\n",
        };
  },
});
