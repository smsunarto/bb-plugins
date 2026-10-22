import { readdirSync } from "node:fs";
import { join } from "node:path";
import { instructionFiles } from "@bb-kit/core/instructions";
import type { Session } from "@bb-kit/core/tools";

const files = instructionFiles(import.meta.url);
const names = readdirSync(join(files.root, "skills"));
// Side chats, BB's review plugin, and this plugin's pre-prompt workers get neither skills nor instructions.
const quiet = new Set(["side-chat", "review", "scott-engineering"]);
// Review children and legacy Arena children answer without starting more children.
const answering = /^(Arena|Review) \((Claude|Codex)\)(?: — .+)?$/;

export function configuration(session: Session) {
  const { parentThreadId, title } = session.thread;
  if (quiet.has(session.origin.pluginId ?? "") || (parentThreadId && answering.test(title ?? "")))
    return { tools: [], skills: [] };
  return { tools: [], skills: names, instructions: files.read("author") };
}
