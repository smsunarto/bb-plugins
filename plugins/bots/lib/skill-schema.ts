import { z } from "zod";

/**
 * A bot skill's shape, shared by the server and the editor. A skill is
 * `<home project>/.bb/skills/<name>/SKILL.md`; BB indexes its frontmatter.
 */
export const SKILLS_MAX = 50;
export const SKILL_CONTENT_MAX = 32_000;
export const SKILL_DESCRIPTION_MAX = 1024;

export const skillNameSchema = z
  .string()
  .max(64)
  .regex(
    /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u,
    "Skill names start with a letter and use lowercase letters, digits, and single hyphens, like weekly-report.",
  );
export const skillContentSchema = z.string().min(1).max(SKILL_CONTENT_MAX);

export type BotSkillSummary = { name: string; description: string };
export type BotSkill = { name: string; content: string; sha256: string };

/** The starting SKILL.md for a new skill; its frontmatter is what BB indexes. */
export function skillTemplate(name: string, description = "") {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n`;
}

export const skillReadToolSchema = z
  .object({
    name: skillNameSchema
      .nullish()
      .describe("Skill to read in full. Omit to list this bot's skills with their descriptions."),
  })
  .strict();
export const skillUpdateToolSchema = z
  .object({
    action: z.enum(["write", "delete"]),
    name: skillNameSchema.describe("The skill's folder name, matching name: in its frontmatter."),
    content: skillContentSchema
      .nullish()
      .describe("The complete SKILL.md, frontmatter included. Required for write."),
    expectedSha256: z
      .string()
      .nullish()
      .describe("sha256 from bot_skill_read to replace an existing skill. Omit to create."),
  })
  .strict();
