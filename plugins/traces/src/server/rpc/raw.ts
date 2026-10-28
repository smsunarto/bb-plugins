import type { z } from "zod";
import { traceHostContract } from "../../shared/host-contract.ts";
import { targetSchema, rawInputSchema, rawPageSchema } from "../../shared/schema.ts";
import type { TracesContext } from "../lib/context.ts";

export const rawContract = {
  input: rawInputSchema.extend(targetSchema.shape).strict(),
  output: rawPageSchema,
};

export async function raw(
  ctx: TracesContext,
  { hostId, ...input }: z.output<typeof rawContract.input>,
): Promise<z.input<typeof rawContract.output>> {
  return ctx.bb.hosts
    .experimental_client({ contract: traceHostContract })
    .call("raw", input, { hostId });
}
