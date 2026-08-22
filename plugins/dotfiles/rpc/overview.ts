import { z } from "zod";
import { defineQuery } from "@bb-kit/core/rpc";
import type { Context } from "../server/context.ts";
import {
  gitEntrySchema,
  groupDefinitions,
  type TweakableGroupDefinition,
} from "../server/domain.ts";

function toOverviewGroup(
  group: TweakableGroupDefinition,
  exists: (path: string) => boolean,
  dirtyPaths: ReadonlySet<string>,
) {
  return {
    id: group.id,
    title: group.title,
    files: group.files.map((file) => ({
      ...file,
      exists: exists(file.path),
      dirty: dirtyPaths.has(file.path),
    })),
  };
}

export const overview = defineQuery({
  output: z
    .object({
      repoPath: z.string(),
      repoExists: z.boolean(),
      branch: z.string(),
      groups: z.array(
        z
          .object({
            id: z.string(),
            title: z.string(),
            files: z.array(
              z
                .object({
                  path: z.string(),
                  title: z.string(),
                  note: z.string().optional(),
                  render: z.boolean().optional(),
                  exists: z.boolean(),
                  dirty: z.boolean(),
                })
                .strict(),
            ),
          })
          .strict(),
      ),
      gitEntries: z.array(gitEntrySchema),
    })
    .strict(),
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
