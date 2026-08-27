import { defineMutation } from "@bb-kit/core/rpc";
import { publishTask, taskResultSchema } from "../domain.ts";
import { gitFor } from "../git.ts";

export const publish = defineMutation({
  output: taskResultSchema,
  async execute(ctx) {
    const git = gitFor(ctx.bb);
    const repoPath = await git.getRepoPath();
    ctx.bb.log.info(`running publish: ${publishTask.command}`);
    return git.run(repoPath, publishTask.command);
  },
});
