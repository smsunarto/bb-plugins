import { argv, defineCommand } from "@bb-kit/core/command";
import { z } from "zod";

import { send as sendRpc } from "../rpc/send.ts";
import { isThreadId } from "../format.ts";

/** Post a notification. An agent running this from inside a thread gets a
 * notification that opens that thread, without naming it. */
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
    thread: argv.option(
      z.string().refine(isThreadId, "not a thread id").optional(),
      { description: "thread the notification opens" },
    ),
  }),
  async execute(ctx, { message, title, thread }) {
    const input: { message: string; title?: string; threadId?: string; projectId?: string } = {
      message,
    };
    if (title !== undefined) input.title = title;
    const threadId = thread ?? ctx.threadId;
    if (threadId !== undefined) input.threadId = threadId;
    if (ctx.projectId !== undefined) input.projectId = ctx.projectId;
    const { listening } = await sendRpc.execute(ctx, input);
    return listening
      ? { exitCode: 0, stdout: "Queued — a BB window is listening.\n" }
      : { exitCode: 0, stdout: "Held — no BB window is open. It will appear when one is.\n" };
  },
});
