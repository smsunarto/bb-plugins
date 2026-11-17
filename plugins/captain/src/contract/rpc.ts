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

/** Later and Skip may write only these `notices` keys; the check's own keys stay its own. */
export const DEFERRABLE_KEY = /^(ask|blocked|health):[A-Za-z0-9_:.-]{1,200}$/u;

export const captainContract = defineRpcContract({
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
});

export type CaptainContract = typeof captainContract;
export type ChangeRef = z.infer<typeof changeRef>;
