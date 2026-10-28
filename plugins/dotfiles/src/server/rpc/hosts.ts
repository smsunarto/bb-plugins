import { z } from "zod";
import type { GitContext } from "../git.ts";

export const hostsContract = {
  input: z.null(),
  output: z
    .object({
      selectedHostId: z.string().nullable(),
      hosts: z.array(
        z.object({ id: z.string(), name: z.string(), connected: z.boolean() }).strict(),
      ),
    })
    .strict(),
};

export function hosts(ctx: GitContext): Promise<z.input<typeof hostsContract.output>> {
  return ctx.git.hosts();
}
