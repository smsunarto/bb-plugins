import { z } from "zod";
import { isValidSkillName } from "../../shared/domain.ts";
import { requireConnected, requireRepo, type GitContext } from "../git.ts";

export const removeSkillContract = {
  input: z.object({ hostId: z.string().min(1).optional(), name: z.string() }).strict(),
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
};

export async function removeSkill(
  ctx: GitContext,
  { hostId, name }: z.output<typeof removeSkillContract.input>,
): Promise<z.input<typeof removeSkillContract.output>> {
  if (!isValidSkillName(name)) throw new Error(`invalid skill name: ${name}`);
  const { git } = ctx;
  const repo = requireRepo(await git.inspect(requireConnected(await git.target(hostId))));
  if (!repo.skills.some((skill) => skill.title === name)) return { outcome: "not-found" as const };
  ctx.bb.log.info(`removing skill ${name} on ${repo.hostName} via npx skills`);
  const result = await git.removeSkill(repo, name);
  return { outcome: "completed" as const, ...result };
}
