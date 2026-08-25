import { defineCommand, type CommandContext } from "@bb-kit/core/cli";

import { send as sendRpc } from "../rpc/send.ts";
import type { Context } from "@bb-kit/core/plugin";
import { isThreadId } from "../format.ts";

const USAGE = 'usage: bb notify send "<message>" [--title <text>] [--thread <id>]\n';

/** Post a notification. An agent running this from inside a thread gets a
 * notification that opens that thread, without naming it. */
export const send = defineCommand({
  summary: "Post a notification",
  configure: (command) => {
    // Variadic so unquoted multi-word messages join, as the old parser did.
    // Optional at the commander level because --message is an accepted
    // alternative; run() rejects the truly message-less invocation with the
    // usage line.
    command
      .argument("[message...]", "notification text (markdown is stripped)")
      .option("--message <text>", "notification text, as a flag instead of the argument")
      .option("--title <text>", "heading shown instead of bb")
      .option("--thread <id>", "thread the notification opens");
  },
  run: async (context: CommandContext<Context>, { args, options }) => {
    const {
      message: messageFlag,
      title,
      thread,
    } = options as {
      message?: string;
      title?: string;
      thread?: string;
    };
    // Commander delivers the variadic argument as one nested array; flat()
    // unwraps it. Positional wins over --message, and a whitespace-only
    // message is no message at all — same order and outcome as the old
    // parseSendArgs.
    const message = (args.flat().join(" ") || messageFlag || "").trim();
    if (message === "") {
      return { exitCode: 2, stderr: USAGE };
    }
    if (thread !== undefined && !isThreadId(thread)) {
      return { exitCode: 2, stderr: `not a thread id: ${thread}\n` };
    }
    const input: { message: string; title?: string; threadId?: string; projectId?: string } = {
      message,
    };
    if (title !== undefined) input.title = title;
    const threadId = thread ?? context.cli.threadId;
    if (threadId !== undefined) input.threadId = threadId;
    if (context.cli.projectId !== undefined) input.projectId = context.cli.projectId;
    const { listening } = await sendRpc.handler(context, input);
    return listening
      ? { exitCode: 0, stdout: "Queued — a BB window is listening.\n" }
      : { exitCode: 0, stdout: "Held — no BB window is open. It will appear when one is.\n" };
  },
});
