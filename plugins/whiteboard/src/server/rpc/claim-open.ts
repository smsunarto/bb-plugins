import type { z } from "zod";
import { claimOpenInput, claimOpenOutput } from "../../shared/contracts/api-tunnel.ts";
import type { WhiteboardContext } from "../lib/context.ts";

/**
 * A thread's header listener asks, on mount and reconnect, whether an agent
 * opened a session there while no client showed the thread (design §3.6).
 * After focusing an open, it calls again with `after`, so the server forgets
 * it and no other pane or window focuses it.
 */
export const claimOpenContract = { input: claimOpenInput, output: claimOpenOutput };

export async function claimOpen(
  ctx: WhiteboardContext<"engine">,
  input: z.output<typeof claimOpenContract.input>,
): Promise<z.input<typeof claimOpenContract.output>> {
  return { open: await ctx.engine.claimOpen(input.threadId, input.after) };
}
