import type { z } from "zod";
import { traceHostContract } from "../../shared/host-contract.ts";
import { targetSchema, scanInputSchema, statusSchema } from "../../shared/schema.ts";
import type { TracesContext } from "../lib/context.ts";

export const scanContract = {
  input: scanInputSchema.extend(targetSchema.shape).strict(),
  output: statusSchema,
};

export async function scan(
  ctx: TracesContext,
  { hostId, ...input }: z.output<typeof scanContract.input>,
): Promise<z.input<typeof scanContract.output>> {
  return ctx.bb.hosts
    .experimental_client({ contract: traceHostContract })
    .call("scan", input, { hostId });
}
