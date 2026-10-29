import { textFilePattern } from "../../../shared/text-files.ts";
import {
  existsSync,
  chmodSync,
  statSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  INSTRUCTIONS_DIR,
  TOOL_INSTRUCTIONS_MAX_CHARS,
  TOOL_INSTRUCTIONS_SUFFIX,
  TOOLS_DIR,
  placeholders,
} from "@bb-plugins/instructions";
import type { AgentFile, FileContent, FileKind, Plugin, SaveInput } from "../../shared/schema.ts";

/** The fields of bb's installed-plugin record this module reads. */
export type InstalledPlugin = {
  id: string;
  name: string | null;
  rootDir: string;
  source: string;
  sourceDisplay: string;
  status: string;
  capabilities: ReadonlyArray<{ kind: string; id: string; detail: string | null }>;
};

const SKILLS_DIR = "skills";
const TOOL_FILE = new RegExp(
  `^${INSTRUCTIONS_DIR}/${TOOLS_DIR}/([^/]+?)(${TOOL_INSTRUCTIONS_SUFFIX.replace(".", "\\.")})?\\.md$`,
);

export function classify(path: string): { kind: FileKind; tool: string | null } | null {
  if (!path.endsWith(".md"))
    return path.startsWith(`${SKILLS_DIR}/`) && textFilePattern.test(path)
      ? { kind: "reference", tool: null }
      : null;
  const tool = TOOL_FILE.exec(path);
  if (tool) {
    return { kind: tool[2] ? "tool-instructions" : "tool-description", tool: tool[1] ?? null };
  }
  if (path.startsWith(`${INSTRUCTIONS_DIR}/`)) return { kind: "prompt", tool: null };
  if (path.startsWith(`${SKILLS_DIR}/`))
    return { kind: path.endsWith("/SKILL.md") ? "skill" : "reference", tool: null };
  return null;
}

/**
 * Only a plugin bb loads from a local checkout is editable. A git or
 * catalog install runs from a cache that the next update overwrites.
 */
function readOnlyReason(plugin: InstalledPlugin): string | null {
  return plugin.source.startsWith("path:")
    ? null
    : `Installed from ${plugin.sourceDisplay}. Install it from a local checkout to edit it.`;
}

/** Whether `path` resolves, through any symlink, to a place under `root`. */
function staysInside(root: string, path: string): boolean {
  const inside = relative(realpathSync(root), realpathSync(path));
  return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside);
}

function markdownFiles(root: string, dir: string): string[] {
  const base = join(root, dir);
  if (!existsSync(base) || !staysInside(root, base)) return [];
  return readdirSync(base, { recursive: true, withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        (dir === SKILLS_DIR ? textFilePattern.test(entry.name) : entry.name.endsWith(".md")),
    )
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((path) => staysInside(root, path))
    .map((path) => relative(root, path).split(sep).join("/"))
    .filter((path) => !path.split("/").includes("node_modules"))
    .sort();
}

function agentFiles(root: string): AgentFile[] {
  return [...markdownFiles(root, INSTRUCTIONS_DIR), ...markdownFiles(root, SKILLS_DIR)].flatMap(
    (path) => {
      const kind = classify(path);
      if (kind === null) return [];
      return [{ path, ...kind, chars: readFileSync(join(root, path), "utf8").trim().length }];
    },
  );
}

/** A plugin's agent text, or null when it gives agents nothing to read. */
export function describePlugin(plugin: InstalledPlugin): Plugin | null {
  const files = agentFiles(plugin.rootDir);
  const live = new Map(
    plugin.capabilities
      .filter((capability) => capability.kind === "agent-tool")
      .map((capability) => [capability.id, capability.detail?.trim() ?? null]),
  );
  // A disabled or failed plugin registers no tools, so its tool files
  // still list here, without live text to compare against.
  const names = new Set([
    ...live.keys(),
    ...files.flatMap((f) => (f.kind === "tool-description" && f.tool ? [f.tool] : [])),
  ]);
  const tools = [...names].map((name) => {
    const file = files.find((f) => f.kind === "tool-description" && f.tool === name);
    const text = file ? readFileSync(join(plugin.rootDir, file.path), "utf8").trim() : null;
    const seen = live.get(name) ?? null;
    return {
      name,
      live: seen,
      file: file?.path ?? null,
      drift: text !== null && seen !== null && text !== seen,
    };
  });
  if (tools.length === 0 && files.length === 0) return null;
  return {
    id: plugin.id,
    name: plugin.name ?? plugin.id,
    status: plugin.status,
    readOnly: readOnlyReason(plugin),
    tools,
    files,
  };
}

/**
 * Resolve a requested path against the plugin's own listing, so a
 * request can only name a file this module would list.
 */
function agentFile(plugin: InstalledPlugin, path: string): AgentFile {
  const file = agentFiles(plugin.rootDir).find((f) => f.path === path);
  if (!file) throw new Error(`${plugin.id} has no agent file ${path}`);
  return file;
}

function contentOf(kind: FileKind, content: string): FileContent {
  return {
    content,
    placeholders: kind === "skill" || kind === "reference" ? [] : placeholders(content),
    maxChars: kind === "tool-instructions" ? TOOL_INSTRUCTIONS_MAX_CHARS : null,
  };
}

export function readAgentFile(plugin: InstalledPlugin, path: string): FileContent {
  const file = agentFile(plugin, path);
  return contentOf(file.kind, readFileSync(join(plugin.rootDir, file.path), "utf8"));
}

function validatePlaceholders(previous: string, text: string): void {
  const before = new Set(placeholders(previous));
  const after = new Set(placeholders(text));
  const removed = [...before].filter((key) => !after.has(key));
  const added = [...after].filter((key) => !before.has(key));
  if (removed.length > 0 || added.length > 0) {
    const list = (keys: string[]) => keys.map((key) => `{{${key}}}`).join(", ");
    throw new Error(
      [
        "The plugin's code fills a fixed set of placeholders.",
        removed.length > 0 ? `Put back ${list(removed)}.` : "",
        added.length > 0 ? `Remove ${list(added)}.` : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
  }
}

/**
 * Check an edit against what the plugin's code relies on, then write it.
 * Throws with a message the editor shows as is. Returns the written file.
 */
export function saveAgentFile(plugin: InstalledPlugin, input: SaveInput): string {
  const reason = readOnlyReason(plugin);
  if (reason !== null) throw new Error(reason);
  const file = agentFile(plugin, input.path);
  const absolute = join(plugin.rootDir, file.path);
  if (readFileSync(absolute, "utf8") !== input.previous) {
    throw new Error(
      `${file.path} changed on disk since you opened it. Reload it to see the change.`,
    );
  }
  const text = file.kind === "reference" ? input.content : input.content.trim();
  if (file.kind !== "skill" && file.kind !== "reference")
    validatePlaceholders(input.previous, text);
  if (file.kind === "tool-description" && text === "") {
    throw new Error("A tool needs a description.");
  }
  if (file.kind === "tool-instructions" && text.length > TOOL_INSTRUCTIONS_MAX_CHARS) {
    throw new Error(
      `bb rejects a tool snippet over ${TOOL_INSTRUCTIONS_MAX_CHARS} characters; this one has ${text.length}.`,
    );
  }
  // Write beside the file and rename, so the plugin never reads half an edit.
  const temporary = `${absolute}.prompt-editor-${process.pid}`;
  const written = file.kind === "reference" ? text : `${text}\n`;
  writeFileSync(temporary, written);
  chmodSync(temporary, statSync(absolute).mode);
  renameSync(temporary, absolute);
  return written;
}
