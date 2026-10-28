import type { z } from "zod";
import { apiRequest, apiResponse } from "../../shared/contracts/api-tunnel.ts";
import type { WhiteboardContext } from "../lib/context.ts";

/** The app's tunnel into the in-process review API (design §3.2). Owned by WP7. */
export const apiContract = { input: apiRequest, output: apiResponse };

export async function api(
  ctx: WhiteboardContext<"engine">,
  input: z.output<typeof apiContract.input>,
): Promise<z.input<typeof apiContract.output>> {
  return ctx.engine.request(input);
}
