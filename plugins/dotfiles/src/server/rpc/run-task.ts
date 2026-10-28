import { z } from "zod";
import { taskDefinitions, taskIdSchema, taskResultSchema } from "../../shared/domain.ts";
import type { GitContext } from "../git.ts";

export const runTaskContract = {
  input: z.object({ hostId: z.string().min(1).optional(), task: taskIdSchema }).strict(),
  output: taskResultSchema,
};

export async function runTask(
  ctx: GitContext,
  { hostId, task }: z.output<typeof runTaskContract.input>,
): Promise<z.input<typeof runTaskContract.output>> {
  const { git } = ctx;
  const target = await git.target(hostId);
  const definition = taskDefinitions[task];
  ctx.bb.log.info(`running task ${task} on ${target.hostName}: ${definition.command}`);
  return git.run(target, definition.command);
}
