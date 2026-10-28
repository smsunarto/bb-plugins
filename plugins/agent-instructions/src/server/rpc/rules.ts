import { z } from "zod";
import { rulesStateSchema } from "../../shared/rules.ts";
import type { AgentInstructionsContext } from "../lib/store.ts";

export const rulesContract = {
  experimental_description: "List the instruction rules in order, with the revision they are at",
  input: z.null(),
  output: rulesStateSchema,
};

export async function rules(
  ctx: AgentInstructionsContext,
): Promise<z.input<typeof rulesContract.output>> {
  return ctx.store.state();
}
