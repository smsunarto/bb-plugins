import type { z } from "zod";
import { traceHostContract } from "../../shared/host-contract.ts";
import { targetSchema, eventQuerySchema, eventPageSchema } from "../../shared/schema.ts";
import type { TracesContext } from "../lib/context.ts";

export const eventsContract = {
  input: eventQuerySchema.extend(targetSchema.shape).strict(),
  output: eventPageSchema,
};

export async function events(
  ctx: TracesContext,
  { hostId, ...input }: z.output<typeof eventsContract.input>,
): Promise<z.input<typeof eventsContract.output>> {
  return ctx.bb.hosts
    .experimental_client({ contract: traceHostContract })
    .call("events", input, { hostId });
}
