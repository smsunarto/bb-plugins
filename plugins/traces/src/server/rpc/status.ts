import type { z } from "zod";
import { traceHostContract } from "../../shared/host-contract.ts";
import { targetSchema, statusSchema } from "../../shared/schema.ts";
import type { TracesContext } from "../lib/context.ts";

export const statusContract = {
  input: targetSchema,
  output: statusSchema,
};

export async function status(
  ctx: TracesContext,
  { hostId, ...input }: z.output<typeof statusContract.input>,
): Promise<z.input<typeof statusContract.output>> {
  return ctx.bb.hosts
    .experimental_client({ contract: traceHostContract })
    .call("status", input, { hostId });
}
