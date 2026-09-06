import { defineQuery } from "@bb-kit/core/rpc";
import { traceHostContract } from "../../shared/host-contract.ts";
import { targetSchema, statusSchema } from "../../shared/schema.ts";

export const status = defineQuery({
  input: targetSchema,
  output: statusSchema,
  execute(ctx, { hostId, ...input }) {
    return ctx.bb.hosts
      .experimental_client({ contract: traceHostContract })
      .call("status", input, { hostId });
  },
});
