import { posix } from "node:path";
import { MAX_TREE_BYTES } from "./model.ts";
import { MAX_SKILL_FILES, parseFrontmatter, pathProblems, relativeLinks } from "./skill-rules.ts";

/** The largest text file the editor saves. */
export const MAX_FILE_BYTES = 1_048_576;

type File = { path: string; bytes: Uint8Array };

/** The text of `bytes` when the editor can show and save it: valid UTF-8 with no NUL. */
export function editableText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  const text = Buffer.from(bytes).toString("utf8");
  return Buffer.from(text, "utf8").equals(Buffer.from(bytes)) ? text : null;
}

/** Why `path` cannot name a file inside a skill, or null. */
export function pathError(path: string): string | null {
  if (path.length > 512) return `${path.slice(0, 40)}…: paths are limited to 512 characters`;
  if (path.includes("\\") || path.includes("\0") || /[\r\n]/.test(path))
    return `${path}: use / between folders, with no backslashes or line breaks`;
  if (path.split("/").some((s) => s === "" || s === "." || s === ".."))
    return `${path}: must be a plain path inside the skill, such as references/notes.md`;
  return null;
}

/**
 * Paths that cannot all exist on one disk: a path that is a file and also a
 * folder of another, or two paths that differ only in case (macOS disks
 * usually ignore case, and the publisher must write the same tree everywhere).
 */
export function pathCollisions(
  paths: readonly string[],
): { paths: [string, string]; message: string }[] {
  const problems: { paths: [string, string]; message: string }[] = [];
  const byKey = new Map<string, string>();
  const folders = new Map<string, string>();
  for (const path of paths) {
    const key = path.toLowerCase();
    const other = byKey.get(key);
    if (other !== undefined)
      problems.push({ paths: [path, other], message: `${path} and ${other} differ only in case` });
    else byKey.set(key, path);
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const folder = parts.slice(0, i).join("/");
      if (!folders.has(folder.toLowerCase())) folders.set(folder.toLowerCase(), path);
    }
  }
  for (const [key, path] of byKey) {
    const inside = folders.get(key);
    if (inside !== undefined)
      problems.push({
        paths: [path, inside],
        message: `${path} is a file, but ${inside} needs it as a folder`,
      });
  }
  return problems;
}

export type TreeCheck = { errors: string[]; warnings: string[]; description: string };

/**
 * Checks a skill's files after an edit. Errors are what would break bb or
 * publishing, and block the save; warnings are paths that may not resolve
 * once published, and only for the files this edit changed.
 */
export function checkSkillTree(
  name: string,
  files: readonly File[],
  changed: ReadonlySet<string>,
  siblings: ReadonlySet<string>,
): TreeCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const skill = skillDescription(name, files);
  if ("error" in skill) errors.push(skill.error);
  if (files.length > MAX_SKILL_FILES)
    errors.push(`${files.length} files; bb accepts at most ${MAX_SKILL_FILES} in a skill`);
  const total = files.reduce((sum, f) => sum + f.bytes.length, 0);
  if (total > MAX_TREE_BYTES)
    errors.push(`The skill is ${total} bytes; the limit is ${MAX_TREE_BYTES}`);
  // A clash this edit did not cause, such as an imported README.md beside readme.md, only warns.
  for (const clash of pathCollisions(files.map((f) => f.path)))
    (clash.paths.some((p) => changed.has(p)) ? errors : warnings).push(clash.message);
  for (const file of files) {
    if (!changed.has(file.path)) continue;
    const error = pathError(file.path);
    if (error) errors.push(error);
    if (file.bytes.length > MAX_FILE_BYTES)
      errors.push(`${file.path}: larger than the editor's ${MAX_FILE_BYTES}-byte limit`);
    const text = editableText(file.bytes);
    if (text !== null) warnings.push(...pathProblems(file.path, text, siblings));
  }
  return { errors, warnings, description: "description" in skill ? skill.description : "" };
}

/** The description SKILL.md gives the skill, or why bb would not load it. */
function skillDescription(
  name: string,
  files: readonly File[],
): { error: string } | { description: string } {
  const skillFile = files.find((f) => f.path === "SKILL.md");
  const text = skillFile ? editableText(skillFile.bytes) : null;
  if (text === null) return { error: "A skill needs a SKILL.md text file" };
  const parsed = parseFrontmatter(text);
  if ("error" in parsed) return { error: `SKILL.md: ${parsed.error}` };
  if (parsed.name !== name)
    return { error: `SKILL.md declares name ${parsed.name}; it must be ${name}, the skill's name` };
  return { description: parsed.description };
}

/** Files in other skills whose relative links point into `target`'s folder. */
export function linksInto(
  target: string,
  others: readonly { name: string; files: readonly File[] }[],
): string[] {
  const found: string[] = [];
  for (const skill of others) {
    if (skill.name === target) continue;
    for (const file of skill.files) {
      const text = editableText(file.bytes);
      if (text === null) continue;
      const hit = relativeLinks(text).some((link) => {
        const resolved = posix.normalize(
          posix.join(posix.dirname(file.path), link.split(/[#?]/)[0]!),
        );
        return resolved === `../${target}` || resolved.startsWith(`../${target}/`);
      });
      if (hit) found.push(`${skill.name}/${file.path}`);
    }
  }
  return found;
}
