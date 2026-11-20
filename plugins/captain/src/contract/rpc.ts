/**
 * The app ↔ server contract for the Needs you banner. Reads are tagged; the
 * server invalidates the tags wherever the data changes, so a CLI `ask`, the
 * banner's own answer and the background check all refresh every banner once.
 *
 * Asks read from `data.db` alone, so they show even while Tasks is slow; the
 * crew read, which waits on bb and Tasks, comes separately.
 */
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { captainIconSchema, iconChoiceSchema } from "./icon.ts";
import { LADDER_ROLES, ladderSchema, rungSchema } from "./ladder.ts";
import { ASK_KINDS } from "./queue.ts";

const threadId = z.string().regex(/^thr_[A-Za-z0-9_-]+$/u);
const askId = z.string().regex(/^a\d+$/u);
const defer = { snoozedUntil: z.number().nullable(), skipOrder: z.number().nullable() };

const askItem = z
  .object({
    kind: z.literal("ask"),
    key: z.string(),
    id: askId,
    askKind: z.enum(ASK_KINDS),
    text: z.string(),
    detail: z.string(),
    options: z.array(z.string()),
    task: z.string().nullable(),
    since: z.number(),
    answer: z.string().nullable(),
    ...defer,
  })
  .strict();

const healthItem = z
  .object({
    kind: z.literal("health"),
    key: z.string(),
    title: z.string(),
    detail: z.string().nullable(),
    task: z.string().nullable(),
    since: z.number().nullable(),
    action: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("retry-thread"), threadId }).strict(),
        z.object({ kind: z.literal("retry-answer"), askId, answer: z.string() }).strict(),
        z.object({ kind: z.literal("open-thread"), threadId }).strict(),
      ])
      .nullable(),
    ...defer,
  })
  .strict();

const blockedItem = z
  .object({
    kind: z.literal("blocked"),
    key: z.string(),
    threadId,
    title: z.string(),
    interactionKind: z.string(),
    task: z.string().nullable(),
    role: z.string().nullable(),
    since: z.number(),
    ...defer,
  })
  .strict();

/** A task or thread a Since you left count opens. */
const changeRef = z
  .object({
    task: z.string().nullable(),
    title: z.string().nullable(),
    threadId: threadId.nullable(),
  })
  .strict();

export const asksTag = (captainId: string) => `asks:${captainId}`;
export const crewTag = (captainId: string) => `crew:${captainId}`;
export const sinceTag = (captainId: string) => `since:${captainId}`;
export const CAPTAINS_TAG = "captains";
export const iconTag = (captainId: string) => `icon:${captainId}`;
/** Any Captain's icon changed: the settings list reads every one. */
export const ICONS_TAG = "icons";
export const LADDERS_TAG = "ladders";

/** Later and Skip may write only these `notices` keys; the check's own keys stay its own. */
export const DEFERRABLE_KEY = /^(ask|blocked|health):[A-Za-z0-9_:.-]{1,200}$/u;

/** A Captain's name: one line of at most this many characters. */
export const CAPTAIN_NAME_MAX = 80;

/** Why `new` refused, and the command or step that clears it. */
const blocker = z.object({ reason: z.string(), fix: z.string() }).strict();

const roleLadderSchema = z
  .object({
    role: z.enum(LADDER_ROLES),
    label: z.string(),
    rungs: z.array(rungSchema),
    /** False while the role runs on the default ladder. */
    custom: z.boolean(),
    defaults: z.array(rungSchema),
  })
  .strict();

export const captainContract = defineRpcContract({
  /** Each dispatched role's model ladder, as Captain settings edit it. */
  ladders: {
    input: z.object({}).strict(),
    output: z.object({ roles: z.array(roleLadderSchema) }).strict(),
    tags: () => [LADDERS_TAG],
  },
  /** Save a role's ladder; null goes back to the default. */
  setLadder: {
    experimental_description:
      "Set the ordered provider, model and reasoning rungs a Captain crew role starts on and falls back through; null restores the default.",
    input: z.object({ role: z.enum(LADDER_ROLES), rungs: ladderSchema.nullable() }).strict(),
    output: roleLadderSchema,
  },
  /** Every live Captain's thread id: one shared read that tells the banner where to render. */
  captains: {
    input: z.object({}).strict(),
    output: z.object({ ids: z.array(threadId) }).strict(),
    tags: () => [CAPTAINS_TAG],
  },
  /** The Captain's open asks and answers still sending, from `data.db` alone. */
  asks: {
    input: z.object({ captainId: threadId }).strict(),
    output: z.object({ items: z.array(z.union([askItem, healthItem])) }).strict(),
    tags: ({ captainId }) => [asksTag(captainId)],
  },
  /** Crew paused on an interaction, and health rows: read live from bb and Tasks. */
  crew: {
    input: z.object({ captainId: threadId }).strict(),
    output: z.object({ items: z.array(z.union([blockedItem, healthItem])) }).strict(),
    tags: ({ captainId }) => [crewTag(captainId)],
  },
  /** What changed since the stored last-seen time: transitions after it, not current state. */
  sinceYouLeft: {
    input: z.object({ captainId: threadId }).strict(),
    output: z
      .object({
        cutoff: z.number().nullable(),
        done: z.array(changeRef),
        ready: z.array(changeRef),
        failed: z.array(changeRef),
      })
      .strict(),
    tags: ({ captainId }) => [sinceTag(captainId)],
  },
  /** Answer an ask through the path `bb captain ask resolve` takes. */
  resolveAsk: {
    experimental_description:
      "Answer a Captain ask as the banner does: record it, post it on the task and send it to the Captain.",
    input: z
      .object({
        askId,
        answer: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .regex(/^[^\r\n]+$/u),
      })
      .strict(),
    output: z
      .object({ state: z.enum(["answered", "undelivered"]), warnings: z.array(z.string()) })
      .strict(),
  },
  /** Later hides an item for an hour; Skip moves it to the back of the queue. */
  defer: {
    input: z
      .object({
        captainId: threadId,
        key: z.string().regex(DEFERRABLE_KEY),
        action: z.enum(["later", "skip"]),
      })
      .strict(),
    output: z.object(defer).strict(),
  },
  /** Advance the Since you left cutoff: on Mark seen, or when the pane is hidden. */
  markSeen: {
    input: z.object({ captainId: threadId, client: z.string().min(1).max(64) }).strict(),
    output: z.object({ at: z.number() }).strict(),
  },
  /**
   * How many items each Captain's Needs you banner holds, for a thread list's
   * rows: one batched read over every row's thread id; 0 for a thread that is
   * not a live Captain. Each row refreshes with its Captain's banner reads.
   */
  needsYou: {
    experimental_description:
      "Count the Needs you items for each thread id that is a live Captain, as its banner counts them; 0 for any other thread.",
    input: z.object({ keys: z.array(z.string().min(1).max(200)).max(500) }).strict(),
    output: z.record(z.string(), z.number().int().nonnegative()),
    keyTags: (captainId) => [asksTag(captainId), crewTag(captainId)],
  },
  /** Start a Captain as `bb captain new` does, with its first message from `first-turn`. */
  newCaptain: {
    experimental_description:
      "Start a Captain thread directing the given bb projects, as `bb captain new --name --repo` does; a live name converges that Captain. Refusals list every blocker and change nothing.",
    input: z
      .object({
        name: z.string().max(200),
        repos: z.array(z.string().min(1).max(200)).max(50),
      })
      .strict(),
    output: z.discriminatedUnion("ok", [
      z
        .object({
          ok: z.literal(true),
          threadId,
          state: z.enum(["started", "exists"]),
          warnings: z.array(z.string()),
        })
        .strict(),
      z.object({ ok: z.literal(false), blockers: z.array(blocker) }).strict(),
    ]),
  },
  /**
   * Each live Captain's sidebar icon, for a thread list's rows: one batched
   * read over the rows' thread ids. Every key gets an entry, null for a thread
   * that is not a live Captain (an archived one, or any other), so the list
   * keeps its own lead for that row. bb fails a keyed read that omits a key.
   */
  icons: {
    experimental_description:
      "Read the sidebar icon of each thread id: a live Captain's default glyph, bb icon name, or image data URL; null for any other thread.",
    input: z.object({ keys: z.array(z.string().min(1).max(200)).max(500) }).strict(),
    output: z.record(z.string(), captainIconSchema.nullable()),
    keyTags: (captainId) => [iconTag(captainId)],
  },
  /** Every live Captain with its name and icon, for the icon setter in settings. */
  captainIcons: {
    input: z.object({}).strict(),
    output: z
      .object({
        captains: z.array(
          z.object({ threadId, name: z.string(), icon: captainIconSchema }).strict(),
        ),
      })
      .strict(),
    tags: () => [CAPTAINS_TAG, ICONS_TAG],
  },
  /** Set a Captain's sidebar icon, as `bb captain icon` does; null goes back to the default. */
  setIcon: {
    experimental_description:
      "Set a live Captain's sidebar icon to a bb icon name or an image data URL; null restores the default Captain glyph.",
    input: z.object({ captainId: threadId, icon: iconChoiceSchema }).strict(),
    output: captainIconSchema,
  },
});

export type CaptainContract = typeof captainContract;
export type ChangeRef = z.infer<typeof changeRef>;
