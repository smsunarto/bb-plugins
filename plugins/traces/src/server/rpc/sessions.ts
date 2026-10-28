import type { z } from "zod";
import { traceHostContract } from "../../shared/host-contract.ts";
import { targetSchema, sessionQuerySchema, sessionPageSchema } from "../../shared/schema.ts";
import type { TracesContext } from "../lib/context.ts";

export const sessionsContract = {
  input: sessionQuerySchema.extend(targetSchema.shape).strict(),
  output: sessionPageSchema,
};

export async function sessions(
  ctx: TracesContext,
  { hostId, ...input }: z.output<typeof sessionsContract.input>,
): Promise<z.input<typeof sessionsContract.output>> {
  return ctx.bb.hosts
    .experimental_client({ contract: traceHostContract })
    .call("sessions", input, { hostId });
}
