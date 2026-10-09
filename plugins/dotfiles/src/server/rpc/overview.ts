import { z } from "zod";
import { defineQuery } from "@bb-kit/core/rpc";
import {
  gitEntrySchema,
  groupDefinitions,
  isValidSkillName,
  type TweakableGroupDefinition,
} from "../../shared/domain.ts";
import type { GitContext } from "../git.ts";

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

const host = z.object({ id: z.string(), name: z.string() }).strict();

export const overview = defineQuery({
  input: z.object({ hostId: z.string().min(1).optional() }).strict(),
  output: z.discriminatedUnion("state", [
    z.object({ state: z.literal("offline"), host }).strict(),
    z
      .object({
        state: z.literal("ready"),
        host,
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
  ]),
  async execute(ctx: GitContext, { hostId }) {
    const { git } = ctx;
    const target = await git.target(hostId);
    const machine = { id: target.hostId, name: target.hostName };
    if (!target.connected) return { state: "offline" as const, host: machine };
    const repo = await git.inspect(target);
    const missingPaths = new Set(repo.missingPaths);
    const dirtyPaths = new Set(repo.entries.map((entry) => entry.path));
    const removableSkillNames = new Map(
      repo.skills
        .filter((skill) => isValidSkillName(skill.title))
        .map((skill) => [skill.path, skill.title]),
    );
    return {
      state: "ready" as const,
      host: machine,
      repoPath: repo.repoPath,
      repoExists: repo.repoExists,
      branch: repo.branch,
      gitEntries: repo.entries,
      groups: groupDefinitions(repo.skills).map((group) =>
        toOverviewGroup(group, (path) => !missingPaths.has(path), dirtyPaths, removableSkillNames),
      ),
    };
  },
});

export type OverviewResult = z.infer<typeof overview.output>;
