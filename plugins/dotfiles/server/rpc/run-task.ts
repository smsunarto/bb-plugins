import { z } from "zod";
import { defineMutation } from "@bb-kit/core/rpc";
import type { Context } from "@bb-kit/core/plugin";
import { taskDefinitions, taskIdSchema, taskResultSchema } from "../domain.ts";
import { gitFor } from "../git.ts";

export const runTask = defineMutation({
  input: z.object({ task: taskIdSchema }).strict(),
  output: taskResultSchema,
  handler: async (context: Context, { task }) => {
    const git = gitFor(context.bb);
    const repoPath = await git.getRepoPath();
    const definition = taskDefinitions[task];
    context.bb.log.info(`running task ${task}: ${definition.command}`);
    return git.run(repoPath, definition.command);
  },
});
