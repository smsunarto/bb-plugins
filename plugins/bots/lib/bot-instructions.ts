import { instructionFiles } from "@bb-plugins/instructions";
import type { BotMetadata } from "../contract.ts";
import { projectContextInstructions, type BotProjectContext } from "./project-context.ts";
import { MEMORY_MAX_CHARS } from "./memory-limit.ts";

const files = instructionFiles(import.meta.url);

/** The tool guidance BB appends when the bot's tools are selected. Reread so prompt edits apply live. */
export const botGuidance = () =>
  ["bot_read_state", "bot_routine_update", "bot_skill_read"]
    .map((tool) => files.read(`tools/${tool}.instructions`))
    .join("\n\n");

/** The agent-only marker and note a bot conversation's first message carries. */
export const conversationStartText = (token: string, name: string) =>
  files.read("bots/conversation-start", { token, name });

const DYNAMIC_MAX_CHARS = 4096; // PluginAgentConfiguration.instructions SDK contract.
const TRUNCATED = "\n[Truncated: use bot_read_state for complete state.]";
function excerpt(text: string, budget: number) {
  if (budget <= 0) return "";
  if (budget < TRUNCATED.length) return text.slice(0, budget);
  return text.length <= budget
    ? text
    : text.slice(0, Math.max(0, budget - TRUNCATED.length)) + TRUNCATED;
}
/** `mainChat`: the thread is the bot's main chat, which delegates work to subthreads. */
export function botInstructions(bot: BotMetadata, project?: BotProjectContext, mainChat = false) {
  const identity = files.read("bots/prompt-header", {
    name: bot.name.slice(0, 120),
    id: bot.id.slice(0, 128),
  });
  const relationship = project
    ? `\n\n${files.read("bots/prompt-project", { relationship: excerpt(projectContextInstructions(project), 550) })}`
    : "";
  const main = mainChat
    ? `\n\n${files.read("bots/prompt-main-chat", { name: bot.name.slice(0, 120) })}`
    : "";
  const header = `${identity}${relationship}${main}\n\n${files.read("bots/prompt-identity")}\n`;
  // Existing oversized memory remains readable through the tool; never trim storage.
  const memory = `\n\n${files.read("bots/prompt-memory")}\n${excerpt(bot.memory, MEMORY_MAX_CHARS)}`;
  const soulBudget = Math.min(1300, DYNAMIC_MAX_CHARS - header.length - memory.length);
  return header + excerpt(bot.soul, soulBudget) + memory;
}
