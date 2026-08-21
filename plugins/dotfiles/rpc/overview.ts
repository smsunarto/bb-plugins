import { defineQuery } from "@bb-kit/core/rpc";
import type { Context } from "../server/context.ts";
import { overviewOutputSchema } from "../server/contract.ts";
import { groupDefinitions, toOverviewGroup } from "../server/model.ts";

export const overview = defineQuery({
  output: overviewOutputSchema,
  handler: async ({ repository }: Context) => {
    const repoPath = await repository.getRepoPath();
    const repoExists = repository.repoExists(repoPath);
    const skills = repoExists ? repository.discoverSkills(repoPath) : [];
    const status = repoExists
      ? await repository.gitStatus(repoPath)
      : { branch: "missing", entries: [] };
    const dirtyPaths = new Set(status.entries.map((entry) => entry.path));
    return {
      repoPath,
      repoExists,
      branch: status.branch,
      gitEntries: status.entries,
      groups: groupDefinitions(skills).map((group) =>
        toOverviewGroup(group, (path) => repository.pathExists(repoPath, path), dirtyPaths),
      ),
    };
  },
});
