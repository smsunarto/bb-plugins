import type { Context } from "@bb-kit/core/plugin";
import { defineMutation } from "@bb-kit/core/rpc";
import { claimOpenInput, claimOpenOutput } from "../../shared/contracts/api-tunnel.ts";
import type { WhiteboardServices } from "../../shared/contracts/engine.ts";

/**
 * A thread's header listener asks, on mount and reconnect, whether an agent
 * opened a session there while no client showed the thread (design §3.6).
 * After focusing an open, it calls again with `after`, so the server forgets
 * it and no other pane or window focuses it.
 */
export const claimOpen = defineMutation({
  input: claimOpenInput,
  output: claimOpenOutput,
  async execute(ctx: Context<Pick<WhiteboardServices, "engine">>, input) {
    return { open: await ctx.engine.claimOpen(input.threadId, input.after) };
  },
});
