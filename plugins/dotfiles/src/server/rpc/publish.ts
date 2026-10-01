import { defineMutation } from "@bb-kit/core/rpc";
import { publishTask, taskResultSchema } from "../domain.ts";
import type { GitContext } from "../git.ts";

export const publish = defineMutation({
  output: taskResultSchema,
  async execute(ctx: GitContext) {
    const { git } = ctx;
    const repoPath = await git.getRepoPath();
    ctx.bb.log.info(`running publish: ${publishTask.command}`);
    return git.run(repoPath, publishTask.command);
  },
});
