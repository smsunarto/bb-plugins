import { z } from "zod";
import { defineMutation } from "@bb-kit/core/rpc";
import { taskDefinitions, taskIdSchema, taskResultSchema } from "../domain.ts";
import { gitFor } from "../git.ts";

export const runTask = defineMutation({
  input: z.object({ task: taskIdSchema }).strict(),
  output: taskResultSchema,
  async execute(ctx, { task }) {
    const git = gitFor(ctx.bb);
    const repoPath = await git.getRepoPath();
    const definition = taskDefinitions[task];
    ctx.bb.log.info(`running task ${task}: ${definition.command}`);
    return git.run(repoPath, definition.command);
  },
});
