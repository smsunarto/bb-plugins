import { z } from "zod";
import { taskDefinitions, taskIdSchema, taskResultSchema } from "../../shared/domain.ts";
import { requireConnected, type GitContext } from "../git.ts";

export const runTaskContract = {
  input: z
    .object({
      hostId: z.string().min(1).optional(),
      task: taskIdSchema,
      expectedRepoPath: z.string().min(1).optional(),
    })
    .strict(),
  output: taskResultSchema,
};

export async function runTask(
  ctx: GitContext,
  { hostId, task, expectedRepoPath }: z.output<typeof runTaskContract.input>,
): Promise<z.input<typeof runTaskContract.output>> {
  const { git } = ctx;
  const target = requireConnected(await git.target(hostId));
  const executionTarget = expectedRepoPath ? await git.inspect(target) : target;
  if (expectedRepoPath && executionTarget.repoPath !== expectedRepoPath) {
    throw new Error(
      "Dotfiles is configured for another checkout. Select the edited source before applying.",
    );
  }
  const definition = taskDefinitions[task];
  ctx.bb.log.info(`running task ${task} on ${target.hostName}: ${definition.command}`);
  return git.run(executionTarget, definition.command);
}
