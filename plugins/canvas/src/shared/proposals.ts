import { z } from "zod";
import { canvasSourceSchema } from "./document.ts";

export const proposalSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  author: z.enum(["user", "agent"]),
  createdAtMs: z.number(),
  before: z.string().min(1),
  after: z.string(),
  status: z.enum(["pending", "applying", "accepted", "rejected"]),
  decidedAtMs: z.number().optional(),
  receipt: z.object({ beforeSha256: z.string(), afterSha256: z.string() }).optional(),
});
export const proposalsFileSchema = z
  .object({
    version: z.literal(1),
    proposals: z.array(proposalSchema),
  })
  .refine(
    (file) => new Set(file.proposals.map((p) => p.id)).size === file.proposals.length,
    "Proposal IDs must be unique",
  );
export type Proposal = z.infer<typeof proposalSchema>;
export type ProposalsFile = z.infer<typeof proposalsFileSchema>;
export const proposalsInputSchema = z.object({ source: canvasSourceSchema });
export const proposalsOutputSchema = z.object({ file: proposalsFileSchema });
export const decideProposalInputSchema = z.object({
  source: canvasSourceSchema,
  proposal: proposalSchema,
  decision: z.enum(["accept", "reject"]),
  expectedContent: z.string(),
});
export const decideProposalOutputSchema = z.object({
  file: proposalsFileSchema,
  content: z.string(),
  sha256: z.string(),
});

// A proposal is one exact replacement, including enough unchanged context to
// identify its location. Ambiguous edits must never pick the first occurrence.
export function applyReplacement(
  content: string,
  proposal: Pick<Proposal, "before" | "after">,
): string {
  const at = content.indexOf(proposal.before);
  if (!proposal.before || at < 0)
    throw new Error("The proposed text no longer matches. Ask the agent to refresh this edit.");
  if (content.indexOf(proposal.before, at + 1) !== -1)
    throw new Error("This text appears more than once. Add unique context to the proposed edit.");
  return content.slice(0, at) + proposal.after + content.slice(at + proposal.before.length);
}
