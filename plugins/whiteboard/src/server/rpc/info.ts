import type { z } from "zod";
import { infoInput, infoOutput } from "../../shared/contracts/rpc.ts";
import { rpcError } from "../lib/boundary-errors.ts";
import type { WhiteboardContext } from "../lib/context.ts";

/** App version and feature flags for a panel. */
export const infoContract = { input: infoInput, output: infoOutput };

export async function info(
  ctx: WhiteboardContext<"engine">,
  input: z.output<typeof infoContract.input>,
): Promise<z.input<typeof infoContract.output>> {
  try {
    return await ctx.engine.info(input);
  } catch (error) {
    throw rpcError("info", error);
  }
}
