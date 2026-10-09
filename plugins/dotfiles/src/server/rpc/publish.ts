import { z } from "zod";
import { defineMutation } from "@bb-kit/core/rpc";
import { publishTask, taskResultSchema } from "../../shared/domain.ts";
import type { GitContext } from "../git.ts";

export const publish = defineMutation({
  input: z.object({ hostId: z.string().min(1).optional() }).strict(),
  output: taskResultSchema,
  async execute(ctx: GitContext, { hostId }) {
    const { git } = ctx;
    const target = await git.target(hostId);
    ctx.bb.log.info(`running publish on ${target.hostName}: ${publishTask.command}`);
    return git.run(target, publishTask.command);
  },
});
