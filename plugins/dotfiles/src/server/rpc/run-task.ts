import { z } from "zod";
import { defineMutation } from "@bb-kit/core/rpc";
import { taskDefinitions, taskIdSchema, taskResultSchema } from "../../shared/domain.ts";
import type { GitContext } from "../git.ts";

export const runTask = defineMutation({
  input: z.object({ hostId: z.string().min(1).optional(), task: taskIdSchema }).strict(),
  output: taskResultSchema,
  async execute(ctx: GitContext, { hostId, task }) {
    const { git } = ctx;
    const target = await git.target(hostId);
    const definition = taskDefinitions[task];
    ctx.bb.log.info(`running task ${task} on ${target.hostName}: ${definition.command}`);
    return git.run(target, definition.command);
  },
});
