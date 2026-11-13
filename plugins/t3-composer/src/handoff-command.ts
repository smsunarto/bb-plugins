// `/handoff` starts BB's own handoff: the one a provider switch starts, or the "Handoff to new
// thread" row in BB's model picker. The SDK has no call for it, so the composer offers the
// command itself and presses that row (see `startBbHandoff` in bb-picker-driver.ts). The
// command never reaches the agent.
import type {
  ComposerMention,
  ExperimentalComposerCommandSuggestion,
  ExperimentalComposerCommandSuggestionGroup,
} from "@get-bb/plugin-sdk/app";

const NAME = "handoff";
const PLUGIN_ID = "t3-composer";

export const HANDOFF_COMMAND: ExperimentalComposerCommandSuggestion = {
  kind: "command",
  name: NAME,
  source: "command",
  origin: "builtin",
  description: "Hand off to a new thread",
  argumentHint: null,
  pluginId: PLUGIN_ID,
};

const HANDOFF_GROUP: ExperimentalComposerCommandSuggestionGroup = {
  key: `${PLUGIN_ID}:${NAME}`,
  label: "Thread",
  suggestions: [HANDOFF_COMMAND],
};

export function isHandoffCommand(item: ExperimentalComposerCommandSuggestion): boolean {
  return item.pluginId === PLUGIN_ID && item.name === NAME;
}

/** The handoff group for a `/` menu query it matches, or null. */
export function handoffGroupFor(
  query: { char: string; text: string } | null,
): ExperimentalComposerCommandSuggestionGroup | null {
  if (query?.char !== "/") return null;
  return NAME.startsWith(query.text.trim().toLowerCase()) ? HANDOFF_GROUP : null;
}

/**
 * The draft without a leading typed `/handoff`, or null when it does not start with one. A
 * `/handoff` pill is some other command named handoff, chosen from the menu, so it is left for
 * the agent.
 */
export function withoutLeadingHandoff(draft: {
  text: string;
  mentions: readonly ComposerMention[];
}): { text: string; mentions: ComposerMention[] } | null {
  const match = /^\s*\/handoff(?:\s+|$)/i.exec(draft.text);
  if (!match) return null;
  const cut = match[0].length;
  if (draft.mentions.some((mention) => mention.from < cut)) return null;
  return {
    text: draft.text.slice(cut),
    mentions: draft.mentions.map((mention) => ({
      ...mention,
      from: mention.from - cut,
      to: mention.to - cut,
    })),
  };
}

/**
 * Whether the draft still holds BB's handoff block, judged by its pill: a mention of the thread
 * being handed off from. Deleting that pill cancels the handoff.
 */
export function hasHandoffBlock(
  mentions: readonly ComposerMention[],
  sourceThreadId: string,
): boolean {
  return mentions.some(
    (mention) => mention.kind === "thread" && mention.threadId === sourceThreadId,
  );
}

/** The draft without the "Continue from " text BB's block leaves once its pill is deleted. */
export function withoutHandoffRemnant(draft: {
  text: string;
  mentions: readonly ComposerMention[];
}): { text: string; mentions: ComposerMention[] } | null {
  const match = /^Continue from\s*/.exec(draft.text);
  if (!match) return null;
  const cut = match[0].length;
  return {
    text: draft.text.slice(cut),
    mentions: draft.mentions.map((mention) => ({
      ...mention,
      from: mention.from - cut,
      to: mention.to - cut,
    })),
  };
}
