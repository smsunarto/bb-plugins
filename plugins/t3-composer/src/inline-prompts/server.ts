import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { INLINE_PROMPT_PROVIDER_ID, inlinePromptsContract } from "./contract";

/** A prompt is sent whole with each message; anything larger belongs in a skill the agent loads. */
const MAX_PROMPT_BYTES = 32 * 1024;
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u;
const INLINE_KEY = /^inline:[ \t]*true[ \t]*$/mu;

export interface InlinePrompt {
  name: string;
  body: string;
}

/** The body of a SKILL.md marked `inline: true`, or null when the file is not an inline prompt. */
export function parseInlinePrompt(source: string): string | null {
  const match = FRONTMATTER.exec(source);
  if (!match || !INLINE_KEY.test(match[1] ?? "")) return null;
  const body = source.slice(match[0].length).trim();
  return body.length > 0 ? body : null;
}

async function readInlinePrompt(skillsDir: string, name: string): Promise<InlinePrompt | null> {
  if (!SKILL_NAME.test(name)) return null;
  let source: Buffer;
  try {
    source = await readFile(path.join(skillsDir, name, "SKILL.md"));
  } catch {
    return null;
  }
  if (source.length > MAX_PROMPT_BYTES) return null;
  const body = parseInlinePrompt(source.toString("utf8"));
  return body === null ? null : { name, body };
}

/** Inline prompts among bb's user-tier skills, by directory name, which is the skill's name there. */
export async function listInlinePrompts(skillsDir: string): Promise<InlinePrompt[]> {
  let entries: string[];
  try {
    entries = await readdir(skillsDir);
  } catch {
    return [];
  }
  const prompts = await Promise.all(entries.map((name) => readInlinePrompt(skillsDir, name)));
  return prompts
    .filter((prompt): prompt is InlinePrompt => prompt !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function registerInlinePrompts(bb: BbPluginApi) {
  // bb publishes user-tier skills into its data directory on this server, so every client and
  // checkout host sees the same prompts.
  const skillsDir = () => path.join(bb.server.experimental_dataDir, "skills");

  bb.rpc.register(inlinePromptsContract, {
    async inlinePrompts() {
      const prompts = await listInlinePrompts(skillsDir());
      return { names: prompts.map((prompt) => prompt.name) };
    },
  });

  // The composer inserts these pills from its `/` menu; a provider needs a trigger, but `@`
  // searches find nothing here, so the `@` menu is unchanged.
  bb.ui.registerMentionProvider({
    id: INLINE_PROMPT_PROVIDER_ID,
    label: "Inline prompts",
    search: () => [],
    async resolve(name) {
      const prompt = await readInlinePrompt(skillsDir(), name);
      if (prompt === null) {
        throw new Error(
          `/${name} is no longer an inline prompt. Remove the pill and pick it again from the / menu.`,
        );
      }
      return { context: prompt.body };
    },
  });
}
