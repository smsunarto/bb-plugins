import type { ComposerDraft, ComposerMention } from "@get-bb/plugin-sdk/app";

/**
 * Mention providers that attach context to a message instead of naming
 * something in the sentence. Like ChatGPT's attachments, the card shows them
 * as counted chips above the editor and hides their pills in the text.
 */
const CONTEXT_PROVIDERS: Record<string, { one: string; many: string }> = {
  annotation: { one: "annotation", many: "annotations" },
  comment: { one: "comment", many: "comments" },
};

export type PluginMention = Extract<ComposerMention, { kind: "plugin" }>;

export interface ContextMentionGroup {
  key: string;
  label: string;
  mentions: readonly PluginMention[];
}

export function isContextMention(mention: {
  kind: string;
  provider?: string;
}): mention is PluginMention {
  return (
    mention.kind === "plugin" &&
    mention.provider !== undefined &&
    Object.hasOwn(CONTEXT_PROVIDERS, mention.provider)
  );
}

export function contextMentionKey(mention: PluginMention): string {
  return `${mention.pluginId}:${mention.provider}`;
}

/** One group per plugin and provider, in the order each first appears in the draft. */
export function groupContextMentions(mentions: readonly ComposerMention[]): ContextMentionGroup[] {
  const groups = new Map<string, PluginMention[]>();
  for (const mention of mentions) {
    if (!isContextMention(mention)) continue;
    const key = contextMentionKey(mention);
    const group = groups.get(key);
    if (group) group.push(mention);
    else groups.set(key, [mention]);
  }
  return [...groups].map(([key, group]) => {
    const noun = CONTEXT_PROVIDERS[group[0]!.provider]!;
    return {
      key,
      label: `${group.length} ${group.length === 1 ? noun.one : noun.many}`,
      mentions: group,
    };
  });
}

/**
 * The draft without the matching mentions' text, with later mentions shifted to
 * match. A space right after a removed mention, the separator plugins insert
 * with it, goes too, and a draft left with only whitespace becomes empty.
 */
export function withoutMentions(
  draft: ComposerDraft,
  remove: (mention: ComposerMention) => boolean,
): ComposerDraft {
  let text = "";
  let cursor = 0;
  let removed = 0;
  const mentions: ComposerMention[] = [];
  for (const mention of [...draft.mentions].sort((a, b) => a.from - b.from)) {
    if (remove(mention)) {
      const end = draft.text[mention.to] === " " ? mention.to + 1 : mention.to;
      text += draft.text.slice(cursor, mention.from);
      removed += end - mention.from;
      cursor = end;
    } else {
      mentions.push({ ...mention, from: mention.from - removed, to: mention.to - removed });
    }
  }
  text += draft.text.slice(cursor);
  if (mentions.length === 0 && text.trim() === "") return { text: "", mentions };
  return { text, mentions };
}
