import { defineQuery } from "@bb-kit/core/rpc";
import { traceHostContract } from "../../shared/host-contract.ts";
import { targetSchema, sessionQuerySchema, sessionPageSchema } from "../../shared/schema.ts";

export const sessions = defineQuery({
  input: sessionQuerySchema.extend(targetSchema.shape).strict(),
  output: sessionPageSchema,
  execute(ctx, { hostId, ...input }) {
    return ctx.bb.hosts
      .experimental_client({ contract: traceHostContract })
      .call("sessions", input, { hostId });
  },
});
