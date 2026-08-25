import { defineMutation } from "@bb-kit/core/rpc";
import type { Context } from "@bb-kit/core/plugin";
import { publishTask, taskResultSchema } from "../domain.ts";
import { gitFor } from "../git.ts";

export const publish = defineMutation({
  output: taskResultSchema,
  handler: async (context: Context) => {
    const git = gitFor(context.bb);
    const repoPath = await git.getRepoPath();
    context.bb.log.info(`running publish: ${publishTask.command}`);
    return git.run(repoPath, publishTask.command);
  },
});
