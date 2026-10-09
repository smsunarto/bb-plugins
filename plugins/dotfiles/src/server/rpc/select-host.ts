import { z } from "zod";
import { defineMutation } from "@bb-kit/core/rpc";
import type { GitContext } from "../git.ts";

export const selectHost = defineMutation({
  input: z.object({ hostId: z.string().min(1) }).strict(),
  output: z.object({ selectedHostId: z.string() }).strict(),
  async execute(ctx: GitContext, { hostId }) {
    await ctx.git.selectHost(hostId);
    return { selectedHostId: hostId };
  },
});
