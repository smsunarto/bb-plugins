import { z } from "zod";
import { defineQuery } from "@bb-kit/core/rpc";
import {
  gitEntrySchema,
  groupDefinitions,
  isValidSkillName,
  type TweakableGroupDefinition,
} from "../domain.ts";
import { gitFor } from "../git.ts";

function toOverviewGroup(
  group: TweakableGroupDefinition,
  exists: (path: string) => boolean,
  dirtyPaths: ReadonlySet<string>,
  removableSkillNames: ReadonlyMap<string, string>,
) {
  return {
    id: group.id,
    title: group.title,
    files: group.files.map((file) => {
      const removeSkillName = removableSkillNames.get(file.path);
      return {
        ...file,
        exists: exists(file.path),
        dirty: dirtyPaths.has(file.path),
        ...(removeSkillName === undefined ? {} : { removeSkillName }),
      };
    }),
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
                  removeSkillName: z.string().optional(),
                })
                .strict(),
            ),
          })
          .strict(),
      ),
      gitEntries: z.array(gitEntrySchema),
    })
    .strict(),
  async execute(ctx) {
    const git = gitFor(ctx.bb);
    const repoPath = await git.getRepoPath();
    const repoExists = git.repoExists(repoPath);
    const skills = repoExists ? git.discoverSkills(repoPath) : [];
    const status = repoExists ? await git.gitStatus(repoPath) : { branch: "missing", entries: [] };
    const dirtyPaths = new Set(status.entries.map((entry) => entry.path));
    const removableSkillNames = new Map(
      skills
        .filter((skill) => isValidSkillName(skill.title))
        .map((skill) => [skill.path, skill.title]),
    );
    return {
      repoPath,
      repoExists,
      branch: status.branch,
      gitEntries: status.entries,
      groups: groupDefinitions(skills).map((group) =>
        toOverviewGroup(
          group,
          (path) => git.pathExists(repoPath, path),
          dirtyPaths,
          removableSkillNames,
        ),
      ),
    };
  },
});

export type OverviewResult = z.infer<typeof overview.output>;
