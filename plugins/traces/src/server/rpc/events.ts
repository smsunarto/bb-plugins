import { defineQuery } from "@bb-kit/core/rpc";
import { traceHostContract } from "../../shared/host-contract.ts";
import { targetSchema, eventQuerySchema, eventPageSchema } from "../../shared/schema.ts";

export const events = defineQuery({
  input: eventQuerySchema.extend(targetSchema.shape).strict(),
  output: eventPageSchema,
  execute(ctx, { hostId, ...input }) {
    return ctx.bb.hosts
      .experimental_client({ contract: traceHostContract })
      .call("events", input, { hostId });
  },
});
