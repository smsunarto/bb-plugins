import { posix, win32 } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { parse } from "yaml";
import type { BotStore } from "./bot-store.ts";
import { pathKindFromHome } from "./project-creation.ts";
import {
  SKILL_DESCRIPTION_MAX,
  SKILLS_MAX,
  type BotSkill,
  type BotSkillSummary,
} from "./skill-schema.ts";

/**
 * A bot's skills are BB project skills in its home project:
 * `<home>/.bb/skills/<name>/SKILL.md`. BB loads them natively, for every
 * provider, only in threads that run in the home project, so no other bot or
 * project sees them. Elsewhere the bot reads them through `bot_skill_read`.
 * The files are the only copy; this module never caches them.
 */
export const SKILLS_DIR = ".bb/skills";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;

/**
 * Throws the reason BB would skip or misread this SKILL.md. BB parses the
 * frontmatter as YAML, so a line check is not enough: `Use when: x` is
 * invalid YAML and ` #123` starts a comment.
 */
export function validateSkillContent(name: string, content: string) {
  const yaml = FRONTMATTER.exec(content)?.[1];
  if (yaml === undefined)
    throw new Error("SKILL.md must start with YAML frontmatter between --- lines.");
  let fields: unknown;
  try {
    fields = parse(yaml);
  } catch (cause) {
    throw new Error(
      `SKILL.md frontmatter is not valid YAML: ${(cause as Error).message.split("\n")[0]} Quote a value that contains ": " or " #".`,
      { cause },
    );
  }
  const { name: declared, description } = (fields ?? {}) as Record<string, unknown>;
  if (declared !== name)
    throw new Error(`SKILL.md frontmatter must declare name: ${name} to match its folder.`);
  if (typeof description !== "string" || !description.trim())
    throw new Error("SKILL.md frontmatter needs a description saying when to use the skill.");
  if (description.length > SKILL_DESCRIPTION_MAX)
    throw new Error(`The description must stay within ${SKILL_DESCRIPTION_MAX} characters.`);
}

type Home = {
  projectId: string;
  hostId: string;
  root: string;
  dir: string;
  path: typeof posix;
};

export function createBotSkills(
  bb: BbPluginApi,
  store: BotStore,
  /** Creates the bot's home project when it has none, as new conversations do. */
  ensureHome: (botId: string) => Promise<string>,
) {
  async function home(projectId: string): Promise<Home | null> {
    const project = (await bb.sdk.projects.list()).find((entry) => entry.id === projectId);
    const source = project?.sources?.find((entry) => entry.type === "local_path");
    if (!source || source.type !== "local_path") return null;
    const path = pathKindFromHome(source.path) === "win32" ? win32 : posix;
    return {
      projectId,
      hostId: source.hostId,
      root: source.path,
      dir: path.join(source.path, SKILLS_DIR),
      path,
    };
  }
  /** The home a read targets; null when the bot has not needed one yet. */
  async function existingHome(botId: string) {
    const { homeProjectId } = store.require(botId);
    return homeProjectId ? await home(homeProjectId) : null;
  }
  async function requireHome(botId: string) {
    const found = await home(await ensureHome(botId));
    if (!found) throw new Error("This bot's home project has no folder for skills.");
    return found;
  }
  const skillFile = (at: Home, name: string) => at.path.join(at.dir, name, "SKILL.md");

  /** What BB itself indexes from the home project, so the list matches what loads. */
  async function list(botId: string): Promise<BotSkillSummary[]> {
    const at = await existingHome(botId);
    if (!at) return [];
    const { skills } = await bb.sdk.skills.list({ projectId: at.projectId, environmentId: null });
    return skills
      .filter(
        (skill) => skill.scope === "bb-project" && skill.filePath.startsWith(at.dir + at.path.sep),
      )
      .map((skill) => ({ name: skill.name, description: skill.description ?? "" }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, SKILLS_MAX);
  }

  async function read(botId: string, name: string): Promise<BotSkill> {
    const at = await existingHome(botId);
    if (!at) throw new Error(`This bot has no skill named ${name}.`);
    let result;
    try {
      result = await bb.sdk.files.read({
        hostId: at.hostId,
        rootPath: at.root,
        path: skillFile(at, name),
      });
    } catch (cause) {
      if (/ENOENT|not found|no such file/iu.test(String(cause)))
        throw new Error(`This bot has no skill named ${name}.`, { cause });
      throw cause;
    }
    const content =
      result.contentEncoding === "utf8"
        ? result.content
        : Buffer.from(result.content, "base64").toString("utf8");
    return { name, content, sha256: result.sha256 };
  }

  /**
   * Create (`expectedSha256: null`) or replace a skill. The host compares the
   * revision itself, so a write never clobbers an edit made after the read.
   */
  async function save(
    botId: string,
    input: { name: string; content: string; expectedSha256: string | null },
  ) {
    validateSkillContent(input.name, input.content);
    if (input.expectedSha256 === null && (await list(botId)).length >= SKILLS_MAX)
      throw new Error(`A bot keeps at most ${SKILLS_MAX} skills. Delete one first.`);
    const at = await requireHome(botId);
    const result = await bb.sdk.files.write({
      hostId: at.hostId,
      rootPath: at.root,
      path: skillFile(at, input.name),
      content: input.content,
      createParents: true,
      expectedSha256: input.expectedSha256,
    });
    if (result.outcome === "conflict")
      throw new Error(
        result.currentSha256 === null
          ? `The skill ${input.name} no longer exists. Create it again with no expectedSha256.`
          : input.expectedSha256 === null
            ? `A skill named ${input.name} already exists. Read it and pass its sha256 to replace it.`
            : `The skill ${input.name} changed since it was read. Read it again and merge.`,
      );
    return { name: input.name, sha256: result.sha256 };
  }

  /** Removes the skill's whole folder, supporting files included. */
  async function remove(botId: string, name: string) {
    const at = await existingHome(botId);
    if (!at) throw new Error(`This bot has no skill named ${name}.`);
    await read(botId, name);
    await bb.sdk.files.remove({
      hostId: at.hostId,
      rootPath: at.root,
      path: at.path.join(at.dir, name),
      recursive: true,
    });
    return { ok: true as const };
  }

  return { list, read, save, remove };
}
export type BotSkills = ReturnType<typeof createBotSkills>;
