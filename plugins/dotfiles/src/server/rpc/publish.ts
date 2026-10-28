import { z } from "zod";
import { publishTask, taskResultSchema } from "../../shared/domain.ts";
import type { GitContext } from "../git.ts";

export const publishContract = {
  input: z.object({ hostId: z.string().min(1).optional() }).strict(),
  output: taskResultSchema,
};

export async function publish(
  ctx: GitContext,
  { hostId }: z.output<typeof publishContract.input>,
): Promise<z.input<typeof publishContract.output>> {
  const { git } = ctx;
  const target = await git.target(hostId);
  ctx.bb.log.info(`running publish on ${target.hostName}: ${publishTask.command}`);
  return git.run(target, publishTask.command);
}
