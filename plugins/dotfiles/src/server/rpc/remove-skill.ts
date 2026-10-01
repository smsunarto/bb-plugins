import { z } from "zod";
import { defineMutation } from "@bb-kit/core/rpc";
import { isValidSkillName } from "../domain.ts";
import type { GitContext } from "../git.ts";

export const removeSkill = defineMutation({
  input: z.object({ name: z.string() }).strict(),
  output: z.discriminatedUnion("outcome", [
    z
      .object({
        outcome: z.literal("completed"),
        exitCode: z.number().int(),
        output: z.string(),
      })
      .strict(),
    z.object({ outcome: z.literal("not-found") }).strict(),
  ]),
  async execute(ctx: GitContext, { name }) {
    if (!isValidSkillName(name)) throw new Error(`invalid skill name: ${name}`);
    const { git } = ctx;
    const repoPath = await git.getRepoPath();
    const skillExists = git.discoverSkills(repoPath).some((skill) => skill.title === name);
    if (!skillExists) return { outcome: "not-found" as const };
    ctx.bb.log.info(`removing skill ${name} via npx skills`);
    const result = await git.removeSkill(repoPath, name);
    return { outcome: "completed" as const, ...result };
  },
});
