import { posix } from "node:path";
import { parse as parseYaml } from "yaml";

/** bb's skill-name contract. The published folder name must equal it. */
export const SKILL_NAME_PATTERN = /^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const MAX_DESCRIPTION_LENGTH = 1024;
/** bb's daemon refuses a skill tree with more files than this. */
export const MAX_SKILL_FILES = 1000;

export type Frontmatter = { name: string; description: string };

export const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** The skill's `name` and `description`, or why bb would skip it. */
export function parseFrontmatter(text: string): Frontmatter | { error: string } {
  const block = FRONTMATTER.exec(text)?.[1];
  if (block === undefined) return { error: "SKILL.md has no YAML frontmatter" };
  let data: unknown;
  try {
    data = parseYaml(block);
  } catch (error) {
    return { error: `frontmatter is not valid YAML: ${(error as Error).message.split("\n")[0]}` };
  }
  if (!data || typeof data !== "object") return { error: "frontmatter is not a mapping" };
  const { name, description } = data as Record<string, unknown>;
  if (typeof name !== "string" || !SKILL_NAME_PATTERN.test(name))
    return { error: `name ${JSON.stringify(name)} is not a valid bb skill name` };
  if (
    typeof description !== "string" ||
    description.trim().length === 0 ||
    description.length > MAX_DESCRIPTION_LENGTH
  )
    return { error: `description must be 1-${MAX_DESCRIPTION_LENGTH} characters` };
  return { name, description };
}

// An absolute path into a provider's or ~/.agents' skill folders only works
// where dotfiles installed it; bb publishes skills at content-addressed paths.
// The last segment must look like a skill or plugin folder, so provider files
// such as ~/.claude/plugins/installed_plugins.json are not flagged.
const INSTALL_PATH =
  /(?:~|\$HOME|\$\{HOME\})\/\.(?:agents|claude)\/(?:skills|plugins)\/[a-z0-9][a-z0-9-]*(?![\w-]|\.\w)/g;
// An inline link `[text](target "title")` or a reference definition `[label]: target`;
// the target is in group 1 or group 2.
const MARKDOWN_LINK =
  /\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)|^ {0,3}\[(?!\^)[^\]\n]+\]:[ \t]*<?([^\s>]+)>?/gm;
const FENCED_CODE = /^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm;

const isRelative = (target: string) =>
  !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith("#") && !target.startsWith("/");

/**
 * Paths in one skill file that will not resolve once the skill is published
 * on its own: install-location paths, and links that leave the skill folder
 * for anything other than a sibling skill in the catalog.
 */
export function pathProblems(path: string, text: string, siblings: ReadonlySet<string>): string[] {
  const problems = new Set<string>();
  for (const match of text.matchAll(INSTALL_PATH))
    problems.add(`${path}: uses the install path ${match[0]}; refer to it relative to the skill`);
  // Links inside code fences are examples, not dependencies.
  for (const match of text.replace(FENCED_CODE, "").matchAll(MARKDOWN_LINK)) {
    const target = (match[1] ?? match[2])!;
    if (!isRelative(target)) continue;
    const resolved = posix.normalize(posix.join(posix.dirname(path), target.split(/[#?]/)[0]!));
    if (resolved !== ".." && !resolved.startsWith("../")) continue;
    const sibling = /^\.\.\/([^/]+)(?:\/|$)/.exec(resolved)?.[1];
    if (sibling !== undefined && siblings.has(sibling)) continue;
    problems.add(`${path}: links outside the skill folder (${target})`);
  }
  return [...problems];
}

/** Relative link targets outside code fences; they break wherever the text is published alone. */
export function relativeLinks(text: string): string[] {
  return [...text.replace(FENCED_CODE, "").matchAll(MARKDOWN_LINK)]
    .map((match) => (match[1] ?? match[2])!)
    .filter(isRelative);
}
