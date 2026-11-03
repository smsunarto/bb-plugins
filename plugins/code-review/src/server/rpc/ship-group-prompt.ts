import { z } from "zod";
import { mergeTargetSchema } from "../../shared/pr-actions.ts";
import { reviewGroupSchema } from "../../shared/review-group.ts";
import { branchId } from "../lib/gitbutler.ts";
import { files } from "../lib/instructions.ts";

export const shipGroupPromptContract = {
  input: z.union([
    z.strictObject({
      targets: reviewGroupSchema,
      mergeTargets: z.array(mergeTargetSchema).max(25).default([]),
    }),
    z.strictObject({ mergeTargets: z.tuple([mergeTargetSchema]) }),
  ]),
  output: z.string(),
};

export function shipGroupPrompt(input: z.output<typeof shipGroupPromptContract.input>) {
  const targets = "targets" in input ? input.targets : input.mergeTargets;
  const mergeTargets = input.mergeTargets;
  for (const merge of mergeTargets) {
    if (
      !targets.some(
        (target) =>
          "pr" in target &&
          target.pr === merge.pr &&
          (!target.account || target.account === merge.account),
      )
    )
      throw new Error("Merge target does not match this Review card.");
  }
  for (const target of targets) {
    if (
      "branch" in target &&
      branchId(target.hostId, target.path, target.branchName) !== target.branch
    )
      throw new Error(
        "The branch does not match the checkout shown in this card. Ask the agent to share it again.",
      );
  }
  return files.read("ship-group", {
    action: mergeTargets.length === targets.length ? "Merge" : "Ship",
    targets: JSON.stringify({ targets, mergeTargets }, null, 2),
  });
}
