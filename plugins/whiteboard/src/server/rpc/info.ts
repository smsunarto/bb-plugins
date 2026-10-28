import type { z } from "zod";
import { infoInput, infoOutput } from "../../shared/contracts/api-tunnel.ts";
import type { WhiteboardContext } from "../lib/context.ts";

/** App version and feature flags for a panel (design §3.2). Owned by WP8. */
export const infoContract = { input: infoInput, output: infoOutput };

export async function info(
  ctx: WhiteboardContext<"engine">,
  input: z.output<typeof infoContract.input>,
): Promise<z.input<typeof infoContract.output>> {
  return ctx.engine.info(input);
}
