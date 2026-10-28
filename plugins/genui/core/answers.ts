// The answer sheet's pure rules: in what order a thread's staged answers
// read, and how their text (the "answers block") is kept in the user's
// composer draft without ever touching what the user wrote around it. The
// store and the composer calls are in ui/answerSheet.ts.

/** One staged answer and where its question sits in the conversation. */
export interface StagedEntry {
  /** The assistant message holding the question. */
  readonly message: string;
  /** That message's index in the thread, when known; null until the thread's outline is read. */
  readonly reply: number | null;
  /** Which fence of the message (its ```ui blocks in order). */
  readonly fence: number;
  /** The question's place in its block, in document order. */
  readonly position: number;
  /** Staging order in the thread, which orders replies whose index is unknown. */
  readonly seq: number;
  /** What the agent receives for this question; one line per field for a Form. */
  readonly text: string;
}

/**
 * Reply order: by message (its index in the thread; a message without one,
 * by when its first answer was staged), then fence, then place in the block.
 */
export function orderEntries<E extends StagedEntry>(entries: readonly E[]): E[] {
  const first = new Map<string, number>();
  for (const entry of entries) first.set(entry.message, Math.min(first.get(entry.message) ?? Infinity, entry.seq));
  return [...entries].sort((a, b) => {
    if (a.message !== b.message) {
      if (a.reply !== null && b.reply !== null && a.reply !== b.reply) return a.reply - b.reply;
      return (first.get(a.message) ?? 0) - (first.get(b.message) ?? 0);
    }
    return a.fence - b.fence || a.position - b.position || a.seq - b.seq;
  });
}

/** The answers block for these entries: one line (a Form's several) per answer in reply order; null when there is none. */
export function answersText(entries: readonly StagedEntry[]): string | null {
  const lines = orderEntries(entries)
    .map((entry) => entry.text.trim())
    .filter((text) => text !== "");
  return lines.length === 0 ? null : lines.join("\n");
}

/** A mention pill's place in the draft text (UTF-16 offsets). */
export interface MentionRange {
  readonly from: number;
  readonly to: number;
}

/** The composer's text and its mention pills, as BB's `ComposerDraft`. */
export interface DraftText<M extends MentionRange> {
  readonly text: string;
  readonly mentions: readonly M[];
}

/** The answers block the sheet wrote: its text, and where it stands in the draft text the sheet last saw. */
export interface WrittenBlock {
  readonly text: string;
  readonly from: number;
  readonly to: number;
}

/** What became of the written block after a draft change. */
export type Tracked =
  | { readonly kind: "present"; readonly from: number; readonly to: number }
  /** The user changed it, or it can't be told apart from what they wrote: it is their text now. */
  | { readonly kind: "edited" }
  /** The change took the whole block out. */
  | { readonly kind: "deleted" };

/**
 * Whether `region` reads as `block`: the same lines, where each run of line
 * breaks may have grown (an editor that keeps lines as paragraphs reads them
 * back further apart) but none may vanish, so a TextArea's blank line stays.
 */
export function sameBlock(region: string, block: string): boolean {
  const ours = block.split(/(\n+)/);
  const theirs = region.split(/(\n+)/);
  return ours.length === theirs.length && ours.every((part, index) => (index % 2 === 0 ? part === theirs[index] : theirs[index].length >= part.length));
}

/** Lines of the draft that are whole and the block's own: it starts and ends at line boundaries. */
function ownLines(text: string, from: number, to: number): boolean {
  return (from === 0 || text[from - 1] === "\n") && (to === text.length || text[to] === "\n");
}

/** One alignment of a text change: `before[from, end)` became `after[from, from + inserted.length)`. */
function diff(before: string, after: string, greedy: "prefix" | "suffix"): { from: number; end: number; inserted: string } {
  const most = Math.min(before.length, after.length);
  const prefix = (limit: number) => {
    let length = 0;
    while (length < limit && before[length] === after[length]) length++;
    return length;
  };
  const suffix = (limit: number) => {
    let length = 0;
    while (length < limit && before[before.length - 1 - length] === after[after.length - 1 - length]) length++;
    return length;
  };
  // An insertion of text that repeats its neighbour fits at either end of the repeat; each greed picks one.
  const head = greedy === "prefix" ? prefix(most) : prefix(most - suffix(most));
  const tail = greedy === "prefix" ? suffix(most - head) : suffix(most);
  return { from: head, end: before.length - tail, inserted: after.slice(head, after.length - tail) };
}

function rebase(before: string, after: string, block: WrittenBlock, greedy: "prefix" | "suffix"): Tracked {
  const change = diff(before, after, greedy);
  const shift = change.inserted.length - (change.end - change.from);
  const { from, to } = block;
  // Wholly before or after the block: it moves, and must still be lines of its own (with the line breaks it was accepted with).
  if (change.end <= from || change.from >= to) {
    const moved = change.end <= from ? { from: from + shift, to: to + shift } : { from, to };
    return ownLines(after, moved.from, moved.to) && sameBlock(after.slice(moved.from, moved.to), block.text) ? { kind: "present", ...moved } : { kind: "edited" };
  }
  // Through the block: still it when only its line breaks changed (an editor's paragraphs).
  let start = Math.min(from, change.from);
  let end = Math.max(to, change.end) + shift;
  while (start < end && after[start] === "\n") start++;
  while (end > start && after[end - 1] === "\n") end--;
  if (sameBlock(after.slice(start, end), block.text) && ownLines(after, start, end)) return { kind: "present", from: start, to: end };
  if (change.from <= from && change.end >= to) {
    const kept = block.text.split("\n").some((line) => line.trim() !== "" && change.inserted.includes(line.trim()));
    return kept ? { kind: "edited" } : { kind: "deleted" };
  }
  return { kind: "edited" };
}

/**
 * Follows the block through one draft change, `before` (the text the sheet
 * last saw) to `after`. A change beside the block moves it; one inside it
 * makes it the user's text; one that took it all out deletes it. When the
 * change can be aligned two ways that disagree about the block (the user
 * typed text identical to it next to it), ownership is unclear and the draft
 * is left alone: the block counts as the user's.
 */
export function trackBlock(before: string, after: DraftText<MentionRange>, block: WrittenBlock): Tracked {
  const left: Tracked = before === after.text ? { kind: "present", from: block.from, to: block.to } : rebase(before, after.text, block, "prefix");
  const right = before === after.text ? left : rebase(before, after.text, block, "suffix");
  if (left.kind !== right.kind || (left.kind === "present" && right.kind === "present" && (left.from !== right.from || left.to !== right.to))) {
    return { kind: "edited" };
  }
  // A mention pill over the block (the text alone may not have changed): the user's now.
  if (left.kind === "present" && after.mentions.some((mention) => mention.from < left.to && mention.to > left.from)) return { kind: "edited" };
  return left;
}

/** A draft after writing the block, and where the block now stands (null: none). */
export interface Written<M extends MentionRange> {
  readonly text: string;
  readonly mentions: M[];
  readonly at: { readonly from: number; readonly to: number } | null;
}

/**
 * The draft with the answers block at `at` (where the sheet's block stands;
 * null when the draft holds none of it) changed to `next` (null: no answers).
 * The block is replaced in place and mentions after it move with the text;
 * an emptied sheet takes it out with the paragraph break it added; a first
 * block is appended as its own paragraph. Nothing else the user wrote is
 * touched. Null when there is nothing to write.
 */
export function writeBlock<M extends MentionRange>(draft: DraftText<M>, at: { from: number; to: number } | null, next: string | null): Written<M> | null {
  const { text, mentions } = draft;
  if (at === null) {
    if (next === null) return null;
    // A draft of only whitespace holds nothing of the user's.
    if (text.trim() === "" && mentions.length === 0) return { text: next, mentions: [], at: { from: 0, to: next.length } };
    const gap = text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
    const from = text.length + gap.length;
    return { text: `${text}${gap}${next}`, mentions: [...mentions], at: { from, to: from + next.length } };
  }
  if (next === text.slice(at.from, at.to)) return null;
  let { from, to } = at;
  if (next === null) {
    // Take the paragraph break that set the block apart: before it, or after it when it opens the draft.
    if (from > 0) {
      while (from > 0 && at.from - from < 2 && text[from - 1] === "\n") from--;
    } else {
      while (to < text.length && to - at.to < 2 && text[to] === "\n") to++;
    }
  }
  const inserted = next ?? "";
  const shift = inserted.length - (to - from);
  return {
    text: `${text.slice(0, from)}${inserted}${text.slice(to)}`,
    mentions: mentions.map((mention) => (mention.from >= to ? { ...mention, from: mention.from + shift, to: mention.to + shift } : mention)),
    at: next === null ? null : { from, to: from + inserted.length },
  };
}
