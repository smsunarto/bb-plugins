import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Public surface of `@bb-plugins/instructions`.
 *
 * Every agent-facing string a plugin ships lives as Markdown under
 * `<plugin>/instructions/`, so Agent Instructions → Plugin prompts can show and edit
 * exactly the text the agent receives:
 *
 *   instructions/<name>.md                    thread instructions and prompts
 *   instructions/tools/<tool>.md              a tool's description
 *   instructions/tools/<tool>.instructions.md a tool's optional thread snippet
 *
 * Files are read on every call, never cached, so text read per resolution
 * picks up an edit immediately. Text captured at registration (tool
 * descriptions) applies after `bb plugin reload`.
 */

export const INSTRUCTIONS_DIR = "instructions";
export const TOOLS_DIR = "tools";
/** Suffix of a tool's optional thread-instructions snippet. */
export const TOOL_INSTRUCTIONS_SUFFIX = ".instructions";
/** The host rejects a tool whose instructions snippet exceeds this. */
export const TOOL_INSTRUCTIONS_MAX_CHARS = 4096;

const PLACEHOLDER = /{{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*}}/g;

export type Vars = Readonly<Record<string, string | number>>;

export type ToolText = { description: string; instructions?: string };

export type InstructionFiles = {
  /** The plugin root: the nearest directory holding package.json. */
  readonly root: string;
  /** `<root>/instructions`. */
  readonly dir: string;
  /**
   * Read `instructions/<name>.md`, trimmed. With `vars`, fill every
   * `{{key}}`; a placeholder without a value throws, so a broken edit
   * fails loudly instead of reaching the agent half-rendered.
   */
  read(name: string, vars?: Vars): string;
  /** Read `instructions/tools/<tool>.md` and its optional `.instructions.md`. */
  tool(name: string): ToolText;
};

/** The `{{key}}` names a text references, in first-seen order. */
export function placeholders(text: string): string[] {
  return [...new Set(Array.from(text.matchAll(PLACEHOLDER), (match) => match[1] as string))];
}

export function fill(text: string, vars: Vars): string {
  const missing = placeholders(text).filter((key) => !Object.hasOwn(vars, key));
  if (missing.length > 0) {
    throw new Error(`no value for ${missing.map((key) => `{{${key}}}`).join(", ")}`);
  }
  return text.replace(PLACEHOLDER, (_, key: string) => String(vars[key]));
}

/**
 * Locate the plugin's instruction files from one of its own modules.
 * Pass `import.meta.url`: the server runs from `src/` under `bb plugin dev`
 * and from `dist/` once built, and both sit under the plugin root.
 */
export function instructionFiles(moduleUrl: string): InstructionFiles {
  const root = pluginRoot(moduleUrl);
  const dir = join(root, INSTRUCTIONS_DIR);
  const readFile = (name: string): string => {
    const path = resolve(dir, `${name}.md`);
    const inside = relative(dir, path);
    if (inside.startsWith("..") || isAbsolute(inside)) {
      throw new Error(`instruction "${name}" is outside ${dir}`);
    }
    return readFileSync(path, "utf8").trim();
  };
  return {
    root,
    dir,
    read(name, vars) {
      const text = readFile(name);
      if (vars === undefined) return text;
      try {
        return fill(text, vars);
      } catch (error) {
        throw new Error(`instructions/${name}.md: ${(error as Error).message}`, { cause: error });
      }
    },
    tool(name) {
      const base = `${TOOLS_DIR}/${name}`;
      const description = readFile(base);
      if (description === "") throw new Error(`instructions/${base}.md is empty`);
      const snippet = `${base}${TOOL_INSTRUCTIONS_SUFFIX}`;
      if (!existsSync(join(dir, `${snippet}.md`))) return { description };
      const instructions = readFile(snippet);
      return instructions === "" ? { description } : { description, instructions };
    },
  };
}

/**
 * The nearest directory whose package.json names a package. A build writes
 * a bare `{"type":"module"}` marker into `dist/`, which is not the root.
 */
function pluginRoot(moduleUrl: string): string {
  let dir = dirname(fileURLToPath(moduleUrl));
  while (!isPackageRoot(dir)) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no named package.json above ${moduleUrl}`);
    dir = parent;
  }
  return dir;
}

function isPackageRoot(dir: string): boolean {
  const manifest = join(dir, "package.json");
  if (!existsSync(manifest)) return false;
  const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
  return typeof parsed === "object" && parsed !== null && "name" in parsed;
}
