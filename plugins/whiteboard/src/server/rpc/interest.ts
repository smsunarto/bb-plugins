import type { Context } from "@bb-kit/core/plugin";
import { defineMutation } from "@bb-kit/core/rpc";
import { interestOutput } from "../../shared/contracts/api-tunnel.ts";
import type { WhiteboardServices } from "../../shared/contracts/engine.ts";

/** A mounted panel's heartbeat: keep the engine watching worktrees (design §1.3). */
export const interest = defineMutation({
  output: interestOutput,
  async execute(ctx: Context<Pick<WhiteboardServices, "engine">>) {
    await ctx.engine.renewInterest();
    return {};
  },
});
