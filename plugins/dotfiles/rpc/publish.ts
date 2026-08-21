import { defineMutation } from "@bb-kit/core/rpc";
import type { Context } from "../server/context.ts";
import { publishTask, taskResultSchema } from "../server/domain.ts";

export const publish = defineMutation({
  output: taskResultSchema,
  handler: async ({ repository, log }: Context) => {
    const repoPath = await repository.getRepoPath();
    log(`running publish: ${publishTask.command}`);
    return repository.run(repoPath, publishTask.command);
  },
});
