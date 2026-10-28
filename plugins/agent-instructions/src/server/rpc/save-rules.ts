import { z } from "zod";
import { rulesSchema, saveResultSchema } from "../../shared/rules.ts";
import type { AgentInstructionsContext } from "../lib/store.ts";

export const saveRulesContract = {
  experimental_description: "Replace every instruction rule, unless they changed since `revision`",
  input: z.object({ rules: rulesSchema, revision: z.number().int().nonnegative() }),
  output: saveResultSchema,
};

export async function saveRules(
  ctx: AgentInstructionsContext,
  input: z.output<typeof saveRulesContract.input>,
): Promise<z.input<typeof saveRulesContract.output>> {
  return ctx.store.save(input.rules, input.revision);
}
