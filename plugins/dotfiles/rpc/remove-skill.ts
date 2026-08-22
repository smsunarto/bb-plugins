import { z } from "zod";
import { defineMutation } from "@bb-kit/core/rpc";
import type { Context } from "../server/context.ts";

function isValidSkillName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(name);
}

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
  handler: async ({ repository, log }: Context, { name }) => {
    if (!isValidSkillName(name)) throw new Error(`invalid skill name: ${name}`);
    const repoPath = await repository.getRepoPath();
    // No repoExists guard here, matching the old service: on a missing
    // repository this throws out of discoverSkills.
    const skillExists = repository.discoverSkills(repoPath).some((skill) => skill.title === name);
    if (!skillExists) return { outcome: "not-found" as const };
    log(`removing skill ${name} via npx skills`);
    const result = await repository.removeSkill(repoPath, name);
    return { outcome: "completed" as const, ...result };
  },
});
