import { defineMutation } from "@bb-kit/core/rpc";
import { traceHostContract } from "../../shared/host-contract.ts";
import { targetSchema, configureInputSchema, statusSchema } from "../../shared/schema.ts";

export const configureSources = defineMutation({
  input: configureInputSchema.extend(targetSchema.shape).strict(),
  output: statusSchema,
  execute(ctx, { hostId, ...input }) {
    return ctx.bb.hosts
      .experimental_client({ contract: traceHostContract })
      .call("configureSources", input, { hostId });
  },
});
