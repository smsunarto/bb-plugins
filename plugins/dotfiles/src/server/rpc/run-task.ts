import { z } from "zod";
import { defineMutation } from "@bb-kit/core/rpc";
import { taskDefinitions, taskIdSchema, taskResultSchema } from "../domain.ts";
import type { GitContext } from "../git.ts";

export const runTask = defineMutation({
  input: z.object({ task: taskIdSchema }).strict(),
  output: taskResultSchema,
  async execute(ctx: GitContext, { task }) {
    const { git } = ctx;
    const repoPath = await git.getRepoPath();
    const definition = taskDefinitions[task];
    ctx.bb.log.info(`running task ${task}: ${definition.command}`);
    return git.run(repoPath, definition.command);
  },
});
