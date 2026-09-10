import { defineQuery } from "@bb-kit/core/rpc";
import { proposalsInputSchema, proposalsOutputSchema } from "../../shared/proposals.ts";
import { readProposals } from "../lib/proposals-store.ts";
export const proposals = defineQuery({
  input: proposalsInputSchema,
  output: proposalsOutputSchema,
  execute: (ctx, { source }) => readProposals(ctx.bb, source),
});
