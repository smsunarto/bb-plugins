import { defineMutation } from "@bb-kit/core/rpc";
import { traceHostContract } from "../../shared/host-contract.ts";
import { targetSchema, scanInputSchema, statusSchema } from "../../shared/schema.ts";

export const scan = defineMutation({
  input: scanInputSchema.extend(targetSchema.shape).strict(),
  output: statusSchema,
  execute(ctx, { hostId, ...input }) {
    return ctx.bb.hosts
      .experimental_client({ contract: traceHostContract })
      .call("scan", input, { hostId });
  },
});
