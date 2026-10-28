import type { z } from "zod";
import { traceHostContract } from "../../shared/host-contract.ts";
import { targetSchema, eventInputSchema, eventDetailSchema } from "../../shared/schema.ts";
import type { TracesContext } from "../lib/context.ts";

export const eventContract = {
  input: eventInputSchema.extend(targetSchema.shape).strict(),
  output: eventDetailSchema,
};

export async function event(
  ctx: TracesContext,
  { hostId, ...input }: z.output<typeof eventContract.input>,
): Promise<z.input<typeof eventContract.output>> {
  return ctx.bb.hosts
    .experimental_client({ contract: traceHostContract })
    .call("event", input, { hostId });
}
