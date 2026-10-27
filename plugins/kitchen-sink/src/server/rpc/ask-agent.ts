import { defineMutation } from "@bb-kit/core/rpc";
import { files } from "../lib/instructions.ts";
import { askAgentInputSchema, askAgentOutputSchema } from "../../shared/thread-details.ts";

/**
 * Send a git request to the thread's own agent. bb has no push or pull request
 * API, so the card asks the agent, which follows the repository's instructions.
 */
export const askAgent = defineMutation({
  input: askAgentInputSchema,
  output: askAgentOutputSchema,
  description: "Ask a thread's agent to commit, push, or open its pull request.",
  async execute({ bb }, { threadId, action }) {
    const text = files.read(`thread-details/${action}`);
    // A busy agent finishes its current turn first, as a message the user queued would.
    await bb.sdk.threads.send({
      threadId,
      mode: "queue-if-active",
      input: [{ type: "text", text, mentions: [] }],
    });
    return { ok: true as const };
  },
});
