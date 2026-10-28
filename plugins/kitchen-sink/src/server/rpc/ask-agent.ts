import type { z } from "zod";
import { files } from "../lib/instructions.ts";
import type { KitchenSinkContext } from "../lib/context.ts";
import { askAgentInputSchema, askAgentOutputSchema } from "../../shared/thread-details.ts";

export const askAgentContract = {
  experimental_description: "Ask a thread's agent to commit, push, or open its pull request.",
  input: askAgentInputSchema,
  output: askAgentOutputSchema,
};

/**
 * Send a git request to the thread's own agent. bb has no push or pull request
 * API, so the card asks the agent, which follows the repository's instructions.
 */
export async function askAgent(
  { bb }: KitchenSinkContext,
  { threadId, action }: z.output<typeof askAgentContract.input>,
): Promise<z.input<typeof askAgentContract.output>> {
  const text = files.read(`thread-details/${action}`);
  // A busy agent finishes its current turn first, as a message the user queued would.
  await bb.sdk.threads.send({
    threadId,
    mode: "queue-if-active",
    input: [{ type: "text", text, mentions: [] }],
  });
  return { ok: true as const };
}
