import { defineQuery } from "@bb-kit/core/rpc";
import { traceHostContract } from "../../shared/host-contract.ts";
import { targetSchema, eventInputSchema, eventDetailSchema } from "../../shared/schema.ts";

export const event = defineQuery({
  input: eventInputSchema.extend(targetSchema.shape).strict(),
  output: eventDetailSchema,
  execute(ctx, { hostId, ...input }) {
    return ctx.bb.hosts
      .experimental_client({ contract: traceHostContract })
      .call("event", input, { hostId });
  },
});
