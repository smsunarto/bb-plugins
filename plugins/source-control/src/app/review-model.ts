/**
 * A Change's review as the app draws it: items and drafts that keep their
 * object while their contents stay the same, so a memoized row or
 * annotation redraws only when what it shows changed. Pure apart from the
 * interners' memory of the last build.
 */
import {
  groupItems,
  itemGroup,
  type Anchor,
  type ChangeReview,
  type Draft,
  type ReviewItem,
} from "../core/items.ts";

/** Keeps one object per id while its JSON stays the same. */
export class Interner<T extends { id: string }> {
  private kept = new Map<string, { json: string; value: T }>();

  /** The values, each the last object with the same id and contents. */
  all(values: readonly T[]): T[] {
    const next = new Map<string, { json: string; value: T }>();
    const out = values.map((value) => {
      const json = JSON.stringify(value);
      const old = this.kept.get(value.id);
      const entry = old && old.json === json ? old : { json, value };
      next.set(value.id, entry);
      return entry.value;
    });
    this.kept = next;
    return out;
  }
}

/** The same array as `old` when every element is the same object. */
export function sameArray<T>(old: readonly T[] | undefined, next: readonly T[]): readonly T[] {
  if (old && old.length === next.length && old.every((value, index) => value === next[index]))
    return old;
  return next;
}

export type StableReview = {
  items: readonly ReviewItem[];
  drafts: readonly Draft[];
  selected: ReadonlySet<string>;
};

const NO_ITEMS: readonly ReviewItem[] = Object.freeze([]);
const NO_DRAFTS: readonly Draft[] = Object.freeze([]);
const NOTHING: ReadonlySet<string> = new Set();

export const EMPTY_STABLE: StableReview = { items: NO_ITEMS, drafts: NO_DRAFTS, selected: NOTHING };

/** One consumer's memory of the review it last drew. */
export class ReviewInterner {
  private items = new Interner<ReviewItem>();
  private drafts = new Interner<Draft>();
  private last: StableReview = EMPTY_STABLE;

  stable(review: ChangeReview | undefined): StableReview {
    if (!review) return EMPTY_STABLE;
    const items = sameArray(this.last.items, this.items.all(review.items));
    const drafts = sameArray(this.last.drafts, this.drafts.all(review.drafts));
    const selected = new Set(review.selected);
    const sameSelection =
      selected.size === this.last.selected.size &&
      [...selected].every((id) => this.last.selected.has(id));
    const next = {
      items,
      drafts,
      selected: sameSelection ? this.last.selected : selected,
    };
    if (
      next.items === this.last.items &&
      next.drafts === this.last.drafts &&
      next.selected === this.last.selected
    )
      return this.last;
    this.last = next;
    return next;
  }
}

// ── Labels ─────────────────────────────────────────────────────────────

/** "client.ts:45", or "client.ts" for a comment on the whole file. */
export function placeLabel(anchor: Anchor): string {
  const name = anchor.path.slice(anchor.path.lastIndexOf("/") + 1);
  return anchor.line === null ? name : `${name}:${anchor.line}`;
}

/** A finding's title, or a comment's first line. */
export function itemTitle(item: ReviewItem): string {
  if (item.title) return item.title;
  // Review bots open with hidden markers and HTML (`<!-- cubic:… -->`, `<details>`), which a
  // title line would show raw; the first line of what GitHub renders is the title.
  const visible = item.body.replace(/<!--[\s\S]*?-->/g, "").replace(/<\/?[a-z][^>]*>/gi, "");
  const line = visible.split("\n").find((text) => text.trim() !== "") ?? "";
  return line.trim().replace(/^#+\s+/, "") || "Comment";
}

/** Who wrote an item, as a line says it. */
export function itemAuthor(item: ReviewItem): string {
  return item.origin.kind === "bb" ? "bb" : item.origin.author;
}

/** "4 findings · 2 comments". */
export function countLabel(items: readonly ReviewItem[]): string {
  const findings = items.filter((item) => item.priority !== null).length;
  const comments = items.length - findings;
  return [
    findings > 0 ? `${findings} ${findings === 1 ? "finding" : "findings"}` : null,
    comments > 0 ? `${comments} ${comments === 1 ? "comment" : "comments"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

// ── Per file, for the diff ─────────────────────────────────────────────

export type ItemEntry = {
  kind: "item";
  id: string;
  item: ReviewItem;
  checked: boolean;
  /** Its lines changed since it was written, or it is anchored at another head. */
  outdated: boolean;
  /** "SlopCop · 1 of 4": its group and place in the rail's order. */
  label: string;
  /** The reader's unsent replies to it. */
  replies: readonly Draft[];
};
export type DraftEntry = { kind: "draft"; id: string; draft: Draft };
export type Entry = ItemEntry | DraftEntry;

export type FileReview = { path: string; entries: readonly Entry[] };

function sameEntry(a: Entry, b: Entry): boolean {
  if (a.kind === "draft" || b.kind === "draft")
    return a.kind === b.kind && (a as DraftEntry).draft === (b as DraftEntry).draft;
  return (
    a.item === b.item &&
    a.checked === b.checked &&
    a.outdated === b.outdated &&
    a.label === b.label &&
    sameArray(a.replies, b.replies) === a.replies
  );
}

/** Each file's items and drafts, keeping every unchanged entry, array and file object. */
export class FileReviewInterner {
  private entries = new Map<string, Entry>();
  private files = new Map<string, FileReview>();

  build(review: StableReview, head: string): ReadonlyMap<string, FileReview> {
    const replies = new Map<string, Draft[]>();
    for (const draft of review.drafts)
      if (draft.replyTo !== null) {
        const list = replies.get(draft.replyTo) ?? [];
        list.push(draft);
        replies.set(draft.replyTo, list);
      }
    const itemIds = new Set(review.items.map((item) => item.id));
    const label = new Map<string, string>();
    for (const { group, items } of groupItems(review.items))
      items.forEach((item, index) =>
        label.set(
          item.id,
          group.kind === "person" ? "" : `${group.label} · ${index + 1} of ${items.length}`,
        ),
      );
    const byPath = new Map<string, Entry[]>();
    const add = (path: string, entry: Entry) => {
      const old = this.entries.get(entry.id);
      const kept = old && sameEntry(old, entry) ? old : entry;
      nextEntries.set(entry.id, kept);
      const list = byPath.get(path) ?? [];
      list.push(kept);
      byPath.set(path, list);
    };
    const nextEntries = new Map<string, Entry>();
    for (const item of review.items)
      add(item.anchor.path, {
        kind: "item",
        id: item.id,
        item,
        checked: review.selected.has(item.id),
        outdated: item.state === "outdated" || item.anchor.head !== head,
        label: label.get(item.id) ?? itemGroup(item).label,
        replies: sameArray(
          (this.entries.get(item.id) as ItemEntry | undefined)?.replies,
          replies.get(item.id) ?? [],
        ),
      });
    // A reply to an item no longer listed stands on its own line.
    for (const draft of review.drafts)
      if (draft.replyTo === null || !itemIds.has(draft.replyTo))
        add(draft.anchor.path, { kind: "draft", id: `draft:${draft.id}`, draft });
    this.entries = nextEntries;
    const files = new Map<string, FileReview>();
    for (const [path, entries] of byPath) {
      const old = this.files.get(path);
      const kept = old && sameArray(old.entries, entries) === old.entries ? old : { path, entries };
      files.set(path, kept);
    }
    this.files = files;
    return files;
  }
}

/** Where an entry sits on the diff. */
export function entryAnchor(entry: Entry): Anchor {
  return entry.kind === "item" ? entry.item.anchor : entry.draft.anchor;
}

/** Pierre's side for an anchor's. */
export function annotationSide(anchor: Anchor): "additions" | "deletions" {
  return anchor.side === "LEFT" ? "deletions" : "additions";
}

/** `additions:45`: one annotation per line and side. */
export function lineKey(side: "additions" | "deletions", line: number): string {
  return `${side}:${line}`;
}

// ── Lines a patch shows ────────────────────────────────────────────────

export type PatchLines = {
  /** Every line the diff shows, by `lineKey`, with its row from the top of the diff. */
  rows: ReadonlyMap<string, number>;
};

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const cache = new WeakMap<object, PatchLines>();

/**
 * The lines a unified patch shows on each side, and their row in a unified
 * view: one row per hunk separator, then one per line. A context line is on
 * both sides.
 */
export function patchLines(patch: string): PatchLines {
  const rows = new Map<string, number>();
  let left = 0;
  let right = 0;
  let row = 0;
  let inHunk = false;
  for (const text of patch.split("\n")) {
    const hunk = HUNK.exec(text);
    if (hunk) {
      left = Number(hunk[1]);
      right = Number(hunk[2]);
      row += 1;
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    const mark = text[0];
    if (mark === " ") {
      rows.set(lineKey("deletions", left++), row);
      rows.set(lineKey("additions", right++), row);
      row += 1;
    } else if (mark === "-") {
      rows.set(lineKey("deletions", left++), row);
      row += 1;
    } else if (mark === "+") {
      rows.set(lineKey("additions", right++), row);
      row += 1;
    } else if (mark !== "\\") inHunk = false;
  }
  return { rows };
}

/** `patchLines`, once per patch object. */
export function patchLinesOf(file: { patch: string }): PatchLines {
  let lines = cache.get(file);
  if (!lines) cache.set(file, (lines = patchLines(file.patch)));
  return lines;
}
