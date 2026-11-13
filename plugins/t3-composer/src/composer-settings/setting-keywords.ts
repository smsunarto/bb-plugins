import type {
  ComposerDraftReplacement,
  ComposerDraftSnapshot,
  ComposerMention,
  ComposerSelection,
} from "@get-bb/plugin-sdk/app";

// Typing an exact setting keyword such as `#opus`, `#high` or `#full` and then a space sets
// that picker and removes the keyword. Other `#` words stay as typed.

type PermissionMode = NonNullable<ComposerSelection["permissionMode"]>;

const PERMISSION_KEYWORDS: Record<string, PermissionMode> = {
  auto: "auto",
  approve: "auto",
  full: "full",
  edits: "accept-edits",
};

export interface KeywordSources {
  /** Reasoning level ids the listed providers offer, such as `low` or `xhigh`. */
  reasoningLevels: ReadonlySet<string>;
  /** Starred models, with their display names once BB has listed them. */
  starredModels: readonly { providerId: string; model: string; label?: string }[];
}

export interface KeywordMatch {
  word: string;
  /** The keyword's range in the draft, `#` included. */
  from: number;
  to: number;
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}.]+/u)
    .filter(Boolean);
}

/** Starred models named by `word`: their full id, or one word of their id or display name. */
function starredModelsNamed(word: string, sources: KeywordSources) {
  // A number such as `#5` is an issue or a version, never a model.
  if (!/\p{L}/u.test(word)) return [];
  return sources.starredModels.filter(
    (entry) =>
      entry.model.toLowerCase() === word ||
      words(entry.model).includes(word) ||
      (entry.label !== undefined && words(entry.label).includes(word)),
  );
}

/**
 * What a keyword sets, or null when it names no setting: a permission mode, then a reasoning
 * level, then exactly one starred model.
 */
export function keywordSelection(
  word: string,
  sources: KeywordSources,
): { selection: ComposerSelection } | { error: string } | null {
  const keyword = word.toLowerCase();
  const permissionMode = PERMISSION_KEYWORDS[keyword];
  if (permissionMode) return { selection: { permissionMode } };
  if (sources.reasoningLevels.has(keyword)) return { selection: { reasoningLevel: keyword } };
  const models = starredModelsNamed(keyword, sources);
  if (models.length === 0) return null;
  if (models.length > 1) return { error: `#${word} matches more than one starred model.` };
  return { selection: { providerId: models[0].providerId, model: models[0].model } };
}

/**
 * `#word` tokens finished by whitespace, outside other mentions, that name a setting. A
 * keyword at the end of the draft is still being typed, so it waits for its space.
 */
export function findKeywords(
  draft: ComposerDraftSnapshot,
  sources: KeywordSources,
): KeywordMatch[] {
  const matches: KeywordMatch[] = [];
  for (const match of draft.text.matchAll(/(^|\s)#([\p{L}\p{N}][\p{L}\p{N}._-]*)(?=\s)/gu)) {
    const from = (match.index ?? 0) + match[1].length;
    const to = from + 1 + match[2].length;
    const insideMention = draft.mentions.some((mention) => from < mention.to && to > mention.from);
    if (!insideMention && keywordSelection(match[2], sources) !== null) {
      matches.push({ word: match[2], from, to });
    }
  }
  return matches;
}

/**
 * The draft without these ranges. Each range takes one following space with it, so the words
 * around it keep a single space; mentions shift with the text.
 */
export function withoutRanges(
  draft: ComposerDraftSnapshot,
  ranges: readonly Pick<KeywordMatch, "from" | "to">[],
): ComposerDraftReplacement {
  const cuts = ranges
    .map(({ from, to }) => ({ from, to: draft.text[to] === " " ? to + 1 : to }))
    .sort((left, right) => left.from - right.from);
  const removed = (position: number) =>
    cuts.reduce((total, cut) => total + (cut.to <= position ? cut.to - cut.from : 0), 0);
  let text = "";
  let position = 0;
  for (const cut of cuts) {
    text += draft.text.slice(position, cut.from);
    position = cut.to;
  }
  text += draft.text.slice(position);
  const mentions: ComposerMention[] = draft.mentions.map((mention) => {
    const shift = removed(mention.from);
    return shift === 0
      ? mention
      : { ...mention, from: mention.from - shift, to: mention.to - shift };
  });
  return { text, mentions };
}
