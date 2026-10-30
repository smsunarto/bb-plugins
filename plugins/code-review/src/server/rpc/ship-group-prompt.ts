import { z } from "zod";
import { reviewGroupSchema } from "../../shared/review-group.ts";
import { branchId } from "../lib/gitbutler.ts";
import { files } from "../lib/instructions.ts";

export const shipGroupPromptContract = {
  input: z.strictObject({ targets: reviewGroupSchema }),
  output: z.string(),
};

export function shipGroupPrompt({ targets }: z.output<typeof shipGroupPromptContract.input>) {
  for (const target of targets) {
    if (
      "branch" in target &&
      branchId(target.hostId, target.path, target.branchName) !== target.branch
    )
      throw new Error(
        "The branch does not match the checkout shown in this card. Ask the agent to share it again.",
      );
  }
  return files.read("ship-group", { targets: JSON.stringify(targets, null, 2) });
}
