import { files } from "../instructions.ts";
import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * The engine's package root. Topics under it come from the plugin's
 * `instructions/` files. Tests pass their own root to read a scratch directory.
 */
const EMBEDDED_PACKAGE_ROOT = "/whiteboard";

export const INSTRUCTION_TOPICS = ["authoring", "file-lenses", "scratchpad"] as const;

export type InstructionTopic = (typeof INSTRUCTION_TOPICS)[number];

export interface InstructionContext {
  desktopAvailable: boolean;
  scratchpadEnabled: boolean;
}

export function scratchpadAvailable(context: InstructionContext): boolean {
  return context.desktopAvailable && context.scratchpadEnabled;
}

async function read(root: string, name: string): Promise<string> {
  if (root === EMBEDDED_PACKAGE_ROOT) {
    if (name === "authoring") return `${files.read("authoring")}\n\n${files.read("components")}`;
    if (name === "file-lenses") return files.read("file-lenses");
    if (name === "scratchpad") return files.read("scratchpad");
  }
  const file = path.join(root, "instructions", `${name}.md`);
  return readFile(file, "utf8");
}

export async function renderInstructions(
  topic: InstructionTopic,
  context: InstructionContext,
  root = EMBEDDED_PACKAGE_ROOT,
): Promise<string> {
  if (topic === "scratchpad" && !scratchpadAvailable(context)) {
    return "The Whiteboard scratchpad is turned off. Answer in chat; the scratchpad can be turned on in the Whiteboard plugin settings in bb.";
  }

  if (topic !== "authoring") return read(root, topic);

  const more = scratchpadAvailable(context)
    ? [
        '- Explaining code visually outside a review: `whiteboard_session_get_instructions({topic:"scratchpad"})`',
      ]
    : [];

  return [
    await read(root, "authoring"),
    ...(more.length ? [`## More guidance\n\n${more.join("\n")}`] : []),
  ].join("\n\n");
}
