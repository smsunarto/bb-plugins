import { defineQuery } from "@bb-kit/core/rpc";
import { traceHostContract } from "../../shared/host-contract.ts";
import { targetSchema, rawInputSchema, rawPageSchema } from "../../shared/schema.ts";

export const raw = defineQuery({
  input: rawInputSchema.extend(targetSchema.shape).strict(),
  output: rawPageSchema,
  execute(ctx, { hostId, ...input }) {
    return ctx.bb.hosts
      .experimental_client({ contract: traceHostContract })
      .call("raw", input, { hostId });
  },
});
