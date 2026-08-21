import { z } from "zod";
import { defineMutation } from "@bb-kit/core/rpc";
import type { Context } from "../server/context.ts";
import { taskDefinitions, taskIdSchema, taskResultSchema } from "../server/domain.ts";

const runTaskInputSchema = z.object({ task: taskIdSchema }).strict();

export const runTask = defineMutation({
  input: runTaskInputSchema,
  output: taskResultSchema,
  handler: async ({ repository, log }: Context, { task }) => {
    const repoPath = await repository.getRepoPath();
    const definition = taskDefinitions[task];
    log(`running task ${task}: ${definition.command}`);
    return repository.run(repoPath, definition.command);
  },
});
