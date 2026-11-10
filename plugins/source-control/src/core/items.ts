/**
 * Review items: every finding or comment on a Change, with one id the diff
 * annotation, the rail row and the thread tab's card all use. Two sources
 * feed them: GitHub review threads, classified by author (SlopCop's are its
 * bot's), and the findings a bb review thread reports. Drafts are the
 * reader's own line comments, kept by bb rather than in a pending GitHub
 * review, so they work on a Change with no pull request.
 *
 * Items and drafts are anchored at the head their lines are numbered on. A
 * new head moves an anchor past the hunks above it, or marks it outdated when
 * its own lines changed; an item is never dropped.
 */
import { z } from "zod";
import { diffSideSchema, forgeThreadSchema, problemSchema, type ForgeThread } from "./change.ts";

export { diffSideSchema, forgeThreadSchema, type ForgeThread };

export type DiffSide = z.infer<typeof diffSideSchema>;

const lineSchema = z.number().int().positive();

/** Where an item sits: a line range on one side of a file's diff, at one head. */
export const anchorSchema = z
  .object({
    path: z.string().min(1).max(4096),
    /** Last line of the range on `side`; null for a comment on the whole file. */
    line: lineSchema.nullable(),
    /** First line of a multi-line range; null for one line. */
    startLine: lineSchema.nullable(),
    side: diffSideSchema,
    /** The commit the lines are numbered at. */
    head: z.string().min(4).max(64),
  })
  .strict();
export type Anchor = z.infer<typeof anchorSchema>;

export const itemOriginSchema = z.discriminatedUnion("kind", [
  /** A finding a bb review thread reported. */
  z.object({ kind: z.literal("bb"), threadId: z.string().min(1) }).strict(),
  /** A GitHub review thread, by its first comment's author. */
  z
    .object({
      kind: z.literal("forge"),
      author: z.string(),
      bot: z.boolean(),
      /** Posted by SlopCop: its bot, or its marker in the body. */
      slopcop: z.boolean(),
    })
    .strict(),
]);
export type ItemOrigin = z.infer<typeof itemOriginSchema>;

export const itemStateSchema = z.enum(["open", "outdated", "resolved"]);
export type ItemState = z.infer<typeof itemStateSchema>;

export const itemReplySchema = z
  .object({
    id: z.string(),
    author: z.string(),
    body: z.string(),
    createdAt: z.string(),
    url: z.string().nullable(),
  })
  .strict();
export type ItemReply = z.infer<typeof itemReplySchema>;

export const reviewItemSchema = z
  .object({
    /** `bb:<threadId>:<n>` for a finding, `gh:<thread node id>` for a GitHub thread. */
    id: z.string().min(1).max(512),
    origin: itemOriginSchema,
    /** 0 (P0) to 3 (P3), for a finding; null for a comment. */
    priority: z.number().int().min(0).max(3).nullable(),
    /** A finding's one-line title; null for a comment. */
    title: z.string().nullable(),
    body: z.string(),
    anchor: anchorSchema,
    state: itemStateSchema,
    url: z.string().nullable(),
    createdAt: z.string(),
    /** Later comments in the GitHub thread, oldest first. */
    replies: z.array(itemReplySchema).max(100),
  })
  .strict();
export type ReviewItem = z.infer<typeof reviewItemSchema>;

export const draftStateSchema = z.enum(["pending", "outdated"]);

/** A line comment the reader wrote and has not sent. */
export const draftSchema = z
  .object({
    /** Minted by the client, so saving the same draft twice is one draft. */
    id: z.string().min(1).max(128),
    anchor: anchorSchema,
    body: z.string().max(65_536),
    /** The item this answers, or null for a new comment. */
    replyTo: z.string().max(512).nullable(),
    state: draftStateSchema,
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
export type Draft = z.infer<typeof draftSchema>;

/** What a client sends to save a draft: the server keeps its times and state. */
export const draftInputSchema = draftSchema.pick({
  id: true,
  anchor: true,
  body: true,
  replyTo: true,
});
export type DraftInput = z.infer<typeof draftInputSchema>;

export const reviewRunSchema = z
  .object({
    threadId: z.string(),
    /** The head the review read. */
    head: z.string(),
    state: z.enum(["running", "reported", "finished", "failed"]),
    startedAt: z.number().int().nonnegative(),
    summary: z.string().nullable(),
    findings: z.number().int().nonnegative(),
  })
  .strict();
export type ReviewRun = z.infer<typeof reviewRunSchema>;

/** Everything the rail, the annotations and the thread tab's card draw for one Change. */
export const changeReviewSchema = z
  .object({
    items: z.array(reviewItemSchema),
    drafts: z.array(draftSchema),
    /** Item ids the reader checked. */
    selected: z.array(z.string()),
    /** bb reviews of the Change, newest first. */
    runs: z.array(reviewRunSchema).max(10),
    /** GitHub's threads: when last read, and why not now. */
    forge: z
      .object({ at: z.number().int().nonnegative().nullable(), problem: problemSchema.nullable() })
      .strict(),
  })
  .strict();
export type ChangeReview = z.infer<typeof changeReviewSchema>;

export const EMPTY_REVIEW: ChangeReview = {
  items: [],
  drafts: [],
  selected: [],
  runs: [],
  forge: { at: null, problem: null },
};

// ── Forge threads ──────────────────────────────────────────────────────

const SLOPCOP_MARKER = /<!--\s*slopcop:/;

/** SlopCop posts as its own GitHub App, and marks every comment it writes. */
export function isSlopCop(comment: { author: string; bot: boolean; body: string }): boolean {
  return SLOPCOP_MARKER.test(comment.body) || (comment.bot && /slopcop/i.test(comment.author));
}

/** A GitHub thread as an item at `head`; one with no comment left is none. */
export function forgeItem(thread: ForgeThread, head: string): ReviewItem | null {
  const [first, ...rest] = thread.comments;
  if (!first) return null;
  const line = thread.line ?? thread.originalLine;
  return {
    id: `gh:${thread.id}`,
    origin: { kind: "forge", author: first.author, bot: first.bot, slopcop: isSlopCop(first) },
    priority: null,
    title: null,
    body: first.body,
    anchor: {
      path: thread.path,
      line,
      startLine:
        thread.startLine !== null && line !== null && thread.startLine < line
          ? thread.startLine
          : null,
      side: thread.side,
      head,
    },
    state: thread.isResolved ? "resolved" : thread.isOutdated ? "outdated" : "open",
    url: first.url,
    createdAt: first.createdAt,
    replies: rest.map(({ id, author, body, createdAt, url }) => ({
      id,
      author,
      body,
      createdAt,
      url,
    })),
  };
}

// ── Groups ─────────────────────────────────────────────────────────────

export type ItemGroup = { id: string; label: string; kind: "bb" | "slopcop" | "person" | "bot" };

/** The rail's author group: bb's findings, SlopCop's, then each person or bot by login. */
export function itemGroup(item: Pick<ReviewItem, "origin">): ItemGroup {
  const { origin } = item;
  if (origin.kind === "bb") return { id: "bb", label: "bb", kind: "bb" };
  if (origin.slopcop) return { id: "slopcop", label: "SlopCop", kind: "slopcop" };
  return {
    id: `@${origin.author.toLowerCase()}`,
    label: origin.author,
    kind: origin.bot ? "bot" : "person",
  };
}

const GROUP_ORDER = { bb: 0, slopcop: 1, person: 2, bot: 3 } as const;

/** Items by group, in rail order: groups bb, SlopCop, people, bots; items by priority, then file and line. */
export function groupItems(
  items: readonly ReviewItem[],
): { group: ItemGroup; items: ReviewItem[] }[] {
  const groups = new Map<string, { group: ItemGroup; items: ReviewItem[] }>();
  for (const item of items) {
    const group = itemGroup(item);
    const entry = groups.get(group.id) ?? { group, items: [] };
    entry.items.push(item);
    groups.set(group.id, entry);
  }
  const byPlace = (a: ReviewItem, b: ReviewItem) =>
    (a.priority ?? 9) - (b.priority ?? 9) ||
    a.anchor.path.localeCompare(b.anchor.path) ||
    (a.anchor.line ?? 0) - (b.anchor.line ?? 0);
  for (const entry of groups.values()) entry.items.sort(byPlace);
  return [...groups.values()].toSorted(
    (a, b) =>
      GROUP_ORDER[a.group.kind] - GROUP_ORDER[b.group.kind] ||
      a.group.label.localeCompare(b.group.label),
  );
}

// ── A new head ─────────────────────────────────────────────────────────

/**
 * One file's change between an old head and a new one, in the old file's
 * lines: the lines removed, and where lines were added (before old line `at`).
 * `deleted`: the file is gone at the new head.
 */
export type LineEdits = {
  deleted: boolean;
  removed: number[];
  inserted: { at: number; count: number }[];
};

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** A unified diff of one file as its edits on the old file's lines. */
export function lineEdits(patch: string, deleted: boolean): LineEdits {
  const edits: LineEdits = { deleted, removed: [], inserted: [] };
  let old = 0;
  let inHunk = false;
  for (const text of patch.split("\n")) {
    const hunk = HUNK.exec(text);
    if (hunk) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      // An empty old range names the line before it: what follows comes after that line.
      old = count === 0 ? start + 1 : start;
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    const mark = text[0];
    if (mark === " ") old += 1;
    else if (mark === "-") edits.removed.push(old++);
    else if (mark === "+") {
      const last = edits.inserted.at(-1);
      if (last && last.at === old) last.count += 1;
      else edits.inserted.push({ at: old, count: 1 });
    } else if (mark !== "\\") inHunk = false;
  }
  return edits;
}

/**
 * An anchor at the new head: moved past the edits above it, or null when the
 * edits touch its own lines (it is outdated). Lines on the base side and a
 * file the head did not touch keep their numbers.
 */
export function moveAnchor(
  anchor: Anchor,
  edits: LineEdits | undefined,
  head: string,
): Anchor | null {
  if (anchor.side === "LEFT" || !edits) return { ...anchor, head };
  if (edits.deleted) return null;
  if (anchor.line === null) return { ...anchor, head };
  const first = anchor.startLine ?? anchor.line;
  const last = anchor.line;
  if (edits.removed.some((line) => line >= first && line <= last)) return null;
  if (edits.inserted.some((insert) => insert.at > first && insert.at <= last)) return null;
  const shift = (line: number) =>
    line +
    edits.inserted.reduce((sum, insert) => (insert.at <= line ? sum + insert.count : sum), 0) -
    edits.removed.filter((removed) => removed < line).length;
  return {
    ...anchor,
    line: shift(last),
    startLine: anchor.startLine === null ? null : shift(anchor.startLine),
    head,
  };
}

// ── Conversation ───────────────────────────────────────────────────────

const actorSchema = z.object({ login: z.string(), avatarUrl: z.string().nullable() }).strict();

/** One entry of a pull request's conversation, as code-review's timeline has it. */
export const timelineItemSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("comment"),
      id: z.string(),
      author: actorSchema.nullable(),
      body: z.string(),
      createdAt: z.string(),
      url: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("review"),
      id: z.string(),
      author: actorSchema.nullable(),
      state: z.enum(["approved", "changes_requested", "commented", "dismissed"]),
      body: z.string(),
      createdAt: z.string(),
      url: z.string(),
      /** Inline comments submitted with this review. */
      commentCount: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("commit"),
      id: z.string(),
      oid: z.string(),
      message: z.string(),
      author: actorSchema.nullable(),
      createdAt: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("event"),
      id: z.string(),
      actor: actorSchema.nullable(),
      text: z.string(),
      createdAt: z.string(),
    })
    .strict(),
]);
export type TimelineItem = z.infer<typeof timelineItemSchema>;

export const conversationResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), items: z.array(timelineItemSchema).max(100) }).strict(),
  z.object({ ok: z.literal(false), problem: problemSchema }).strict(),
]);
export type ConversationResult = z.infer<typeof conversationResultSchema>;
