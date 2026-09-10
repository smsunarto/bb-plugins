import { defineMutation } from "@bb-kit/core/rpc";
import { decideProposalInputSchema, decideProposalOutputSchema } from "../../shared/proposals.ts";
import { decideProposal as applyDecision } from "../lib/proposals-store.ts";
export const decideProposal = defineMutation({
  input: decideProposalInputSchema,
  output: decideProposalOutputSchema,
  execute: (ctx, input) => applyDecision(ctx.bb, input),
});
