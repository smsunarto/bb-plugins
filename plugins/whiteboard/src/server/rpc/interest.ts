import { z } from "zod";
import { interestOutput } from "../../shared/contracts/api-tunnel.ts";
import type { WhiteboardContext } from "../lib/context.ts";

/** A mounted panel's heartbeat: keep the engine watching worktrees (design §1.3). */
export const interestContract = { input: z.null(), output: interestOutput };

export async function interest(
  ctx: WhiteboardContext<"engine">,
): Promise<z.input<typeof interestContract.output>> {
  await ctx.engine.renewInterest();
  return {};
}
