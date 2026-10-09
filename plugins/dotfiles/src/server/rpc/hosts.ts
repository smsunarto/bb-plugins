import { z } from "zod";
import { defineQuery } from "@bb-kit/core/rpc";
import type { GitContext } from "../git.ts";

export const hosts = defineQuery({
  output: z
    .object({
      selectedHostId: z.string().nullable(),
      hosts: z.array(
        z.object({ id: z.string(), name: z.string(), connected: z.boolean() }).strict(),
      ),
    })
    .strict(),
  execute(ctx: GitContext) {
    return ctx.git.hosts();
  },
});
