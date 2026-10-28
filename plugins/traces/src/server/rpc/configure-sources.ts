import type { z } from "zod";
import { traceHostContract } from "../../shared/host-contract.ts";
import { targetSchema, configureInputSchema, statusSchema } from "../../shared/schema.ts";
import type { TracesContext } from "../lib/context.ts";

export const configureSourcesContract = {
  input: configureInputSchema.extend(targetSchema.shape).strict(),
  output: statusSchema,
};

export async function configureSources(
  ctx: TracesContext,
  { hostId, ...input }: z.output<typeof configureSourcesContract.input>,
): Promise<z.input<typeof configureSourcesContract.output>> {
  return ctx.bb.hosts
    .experimental_client({ contract: traceHostContract })
    .call("configureSources", input, { hostId });
}
