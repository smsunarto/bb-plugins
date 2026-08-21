import { defineMutation } from "@bb-kit/core/rpc";
import type { Context } from "../server/context.ts";
import { taskResultSchema } from "../server/contract.ts";
import { publishTask } from "../server/model.ts";

export const publish = defineMutation({
  output: taskResultSchema,
  handler: async ({ repository, log }: Context) => {
    const repoPath = await repository.getRepoPath();
    log(`running publish: ${publishTask.command}`);
    return repository.run(repoPath, publishTask.command);
  },
});
