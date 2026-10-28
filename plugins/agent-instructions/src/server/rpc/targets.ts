import { z } from "zod";
import { targetsSchema } from "../../shared/targets.ts";
import type { AgentInstructionsContext } from "../lib/store.ts";
import { loadTargets } from "../lib/targets.ts";

export const targetsContract = {
  experimental_description: "List the hosts, providers, and projects a rule can be scoped to",
  input: z.null(),
  output: targetsSchema,
};

export async function targets(
  ctx: AgentInstructionsContext,
): Promise<z.input<typeof targetsContract.output>> {
  return loadTargets(ctx.bb);
}
