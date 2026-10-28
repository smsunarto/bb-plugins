import { z } from "zod";
import type { GitContext } from "../git.ts";

export const selectHostContract = {
  input: z.object({ hostId: z.string().min(1) }).strict(),
  output: z.object({ selectedHostId: z.string() }).strict(),
};

export async function selectHost(
  ctx: GitContext,
  { hostId }: z.output<typeof selectHostContract.input>,
): Promise<z.input<typeof selectHostContract.output>> {
  await ctx.git.selectHost(hostId);
  return { selectedHostId: hostId };
}
