/**
 * The app ↔ server contract. `changeForThread` is a keyed read the app holds
 * through bb's tagged query hooks; it serves stored state and never calls a
 * host. The server refreshes rows only while a surface watches them.
 */
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  checksValueSchema,
  facetSchema,
  forgeActionSchema,
  forgeResultSchema,
  patchesSchema,
  patchSourceSchema,
  problemSchema,
  revisionSchema,
  threadChangeSchema,
  vcsActionSchema,
  vcsResultSchema,
} from "../core/change.ts";
import { threadStatusSchema } from "../core/status.ts";
import { importReportSchema } from "../core/cutover.ts";
import { landedSchema, landedTargetSchema, prRefSchema } from "../core/watch.ts";
import { guideViewSchema } from "../core/guide.ts";
import {
  changeDetailSchema,
  commitsResultSchema,
  filesResultSchema,
  pageSourcesSchema,
  reviewRevisionSchema,
  sourceRowsSchema,
} from "../core/review.ts";
import {
  agentTargetSchema,
  batchInputSchema,
  batchViewSchema,
  changeReviewSchema,
  conversationResultSchema,
  draftInputSchema,
  draftSchema,
  traySchema,
} from "../core/items.ts";
import {
  accountTag,
  askTag,
  changeKeySchema,
  changeTag,
  checksTag,
  hostTag,
  PAGE_SOURCES_TAG,
  guideTag,
  reviewTag,
  threadTag,
  type ChangeKey,
} from "../core/ids.ts";

export const MAX_THREAD_KEYS = 200;

const threadIdSchema = z.string().min(1).max(128);

const askResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), threadId: z.string() }).strict(),
  z.object({ ok: z.literal(false), message: z.string() }).strict(),
]);

export const sourceControlContract = defineRpcContract({
  changeForThread: {
    experimental_description:
      "Each thread's Change, keyed by thread id: its checkout's branch state from the checkout host and its GitHub pull request, each with when it was last read and any current problem.",
    input: z.object({ keys: z.array(threadIdSchema).min(1).max(MAX_THREAD_KEYS) }).strict(),
    output: z.record(z.string(), threadChangeSchema),
    keyTags: (key: string) => [threadTag(key)],
  },
  statusForThread: {
    experimental_description:
      "Each thread's Change as one list row, keyed by thread id: its pull request (number, title, url, state), a status line, attention chips and a tone, derived exactly as Source Control's own surfaces derive them. Small enough for a row per thread.",
    input: z.object({ keys: z.array(threadIdSchema).min(1).max(MAX_THREAD_KEYS) }).strict(),
    output: z.record(z.string(), threadStatusSchema),
    keyTags: (key: string) => [threadTag(key)],
  },
  refreshThread: {
    experimental_description:
      "Read the thread's checkout and pull request again now, and resolve once its row is current.",
    input: z.object({ threadId: threadIdSchema }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  /** File patches from the thread's checkout. A commit's never change; uncommitted ones refresh with the thread. */
  patches: {
    input: z.object({ threadId: threadIdSchema, source: patchSourceSchema }).strict(),
    output: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), value: patchesSchema }).strict(),
      z.object({ ok: z.literal(false), problem: problemSchema }).strict(),
    ]),
    tags: (input: { threadId: string; source: { kind: string } }) =>
      input.source.kind === "uncommitted" ? [threadTag(input.threadId)] : [],
  },
  vcsAction: {
    experimental_description:
      "Push, pull or land on the thread's checkout, only if it is still at `expected`. Returns `conflict` and changes nothing otherwise. Never retried.",
    input: z
      .object({ threadId: threadIdSchema, action: vcsActionSchema, expected: revisionSchema })
      .strict(),
    output: vcsResultSchema,
  },
  checksForChange: {
    experimental_description:
      "Each Change's checks on its pull request's head, keyed by ChangeKey: every check run and commit status with its outcome and link.",
    input: z.object({ keys: z.array(changeKeySchema).min(1).max(MAX_THREAD_KEYS) }).strict(),
    output: z.record(z.string(), facetSchema(checksValueSchema)),
    keyTags: (key: string) => [checksTag(key as ChangeKey)],
  },
  forgeAction: {
    experimental_description:
      "Mark the thread's pull request draft or ready for review, only while it is still #`expected.number` at `expected.head`. Returns `conflict` and changes nothing otherwise. Convergent: already so returns `upToDate`.",
    input: z
      .object({
        threadId: threadIdSchema,
        action: forgeActionSchema,
        expected: z
          .object({ number: z.number().int().positive(), head: z.string().min(1) })
          .strict(),
      })
      .strict(),
    output: forgeResultSchema,
  },
  pageSources: {
    experimental_description:
      "What the review page lists from: the hosts the placement table has checkouts on, and the GitHub accounts the bb server can read with.",
    input: z.object({}).strict(),
    output: pageSourcesSchema,
    tags: () => [PAGE_SOURCES_TAG],
  },
  inbox: {
    experimental_description:
      "Each account's open pull requests on GitHub, keyed by login: the ones it opened and the ones it is asked to review, as list rows. Read again while watched.",
    input: z.object({ keys: z.array(z.string().min(1).max(100)).min(1).max(20) }).strict(),
    output: z.record(z.string(), sourceRowsSchema),
    keyTags: (key: string) => [accountTag(key)],
  },
  hostChanges: {
    experimental_description:
      "Each host's Changes, keyed by host id: the branches of every checkout the placement table has on it, as list rows from their last read. Read again while watched.",
    input: z.object({ keys: z.array(z.string().min(1).max(128)).min(1).max(50) }).strict(),
    output: z.record(z.string(), sourceRowsSchema),
    keyTags: (key: string) => [hostTag(key)],
  },
  changeDetail: {
    experimental_description:
      "Each Change's review header and rail, keyed by ChangeKey: its pull request, size, the revision its files are read at, and its stack.",
    input: z.object({ keys: z.array(changeKeySchema).min(1).max(20) }).strict(),
    output: z.record(z.string(), changeDetailSchema),
    keyTags: (key: string) => [changeTag(key as ChangeKey), checksTag(key as ChangeKey)],
  },
  /** A Change's files at one revision. Immutable per revision, so never tagged. */
  changeFiles: {
    input: z.object({ key: changeKeySchema, revision: reviewRevisionSchema }).strict(),
    output: filesResultSchema,
  },
  /** File patches of a Change at one revision, for the files near the viewport. Immutable. */
  changePatches: {
    input: z
      .object({
        key: changeKeySchema,
        revision: reviewRevisionSchema,
        paths: z.array(z.string()).min(1).max(40),
      })
      .strict(),
    output: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), value: patchesSchema }).strict(),
      z.object({ ok: z.literal(false), problem: problemSchema }).strict(),
    ]),
  },
  /** A Change's commits at one revision, newest first. Immutable. */
  changeCommits: {
    input: z.object({ key: changeKeySchema, revision: reviewRevisionSchema }).strict(),
    output: commitsResultSchema,
  },
  changeForgeAction: {
    experimental_description:
      "Mark a Change's pull request draft or ready for review, only while it is still #`expected.number` at `expected.head`. Returns `conflict` and changes nothing otherwise.",
    input: z
      .object({
        key: changeKeySchema,
        action: forgeActionSchema,
        expected: z
          .object({ number: z.number().int().positive(), head: z.string().min(1) })
          .strict(),
      })
      .strict(),
    output: forgeResultSchema,
  },
  reviewForChange: {
    experimental_description:
      "Each Change's review, keyed by ChangeKey: its findings and GitHub review comments as items with one id each, the reader's unsent line comments, which items are checked, and its bb review runs.",
    input: z.object({ keys: z.array(changeKeySchema).min(1).max(20) }).strict(),
    output: z.record(z.string(), changeReviewSchema),
    keyTags: (key: string) => [reviewTag(key as ChangeKey)],
  },
  /** Saves a line comment. Idempotent on the draft's client-minted id: a second save edits it. */
  saveDraft: {
    input: z.object({ key: changeKeySchema, draft: draftInputSchema }).strict(),
    output: z.object({ ok: z.literal(true), draft: draftSchema }).strict(),
  },
  /** Deletes a draft; deleting one already gone is fine. */
  deleteDraft: {
    input: z.object({ key: changeKeySchema, id: z.string().min(1).max(128) }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  /** Checks or unchecks items. Convergent. */
  setSelected: {
    input: z
      .object({
        key: changeKeySchema,
        ids: z.array(z.string().min(1).max(512)).min(1).max(500),
        selected: z.boolean(),
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  /** Dismisses a bb finding: it leaves the items, their count and the selection. Convergent. */
  dismissItem: {
    input: z.object({ key: changeKeySchema, id: z.string().min(1).max(512) }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  /** The send tray's destination and target, kept per Change. */
  setTray: {
    input: z.object({ key: changeKeySchema, tray: traySchema }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  /** Threads an agent batch can go to: those on the Change's branch first. Read on demand. */
  agentTargets: {
    input: z.object({ key: changeKeySchema }).strict(),
    output: z.object({ targets: z.array(agentTargetSchema).max(50) }).strict(),
  },
  /**
   * Sends checked items and drafts to an agent thread or as one GitHub
   * review. Keyed on the client's batch id: sending an id again returns the
   * stored outcome and sends nothing more; a queued or failed one is retried.
   */
  sendBatch: {
    experimental_description:
      "Send a Change's checked review items and unsent line comments to an agent thread, or post them as one GitHub review pinned to the reviewed head. The batch id is the client's: repeating it never sends twice.",
    input: z.object({ key: changeKeySchema, batch: batchInputSchema }).strict(),
    output: batchViewSchema,
  },
  /** Stops the agent thread a sent batch went to. */
  stopAgent: {
    input: z.object({ key: changeKeySchema, batchId: z.string().min(1).max(128) }).strict(),
    output: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true) }).strict(),
      z.object({ ok: z.literal(false), message: z.string() }).strict(),
    ]),
  },
  /** Starts a bb review of the Change's head, or returns the one already running on it. */
  startReview: {
    experimental_description:
      "Start a bb agent thread that reviews the Change's current head read-only and reports findings to Source Control, or return the review already running on that head.",
    input: z.object({ key: changeKeySchema }).strict(),
    output: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), threadId: z.string(), reused: z.boolean() }).strict(),
      z.object({ ok: z.literal(false), message: z.string() }).strict(),
    ]),
  },
  /**
   * Each Change's guide and viewed marks, keyed by ChangeKey. Stored state
   * only: reading it never starts a guide run.
   */
  guideForChange: {
    experimental_description:
      "Each Change's reading guide, keyed by ChangeKey: the agent-written groups and notes with the head they were written for, the guide run's state, and the files marked viewed at their blobs. Reading never starts a run.",
    input: z.object({ keys: z.array(changeKeySchema).min(1).max(20) }).strict(),
    output: z.record(z.string(), guideViewSchema),
    keyTags: (key: string) => [guideTag(key as ChangeKey)],
  },
  /**
   * The review page opened the Change: starts its one guide run if it has
   * none yet. Every other surface reads `guideForChange` only.
   */
  openGuide: {
    input: z.object({ key: changeKeySchema }).strict(),
    output: guideViewSchema,
  },
  /**
   * Each Change's Ask thread, keyed by ChangeKey: null until the first
   * question forks one. Stored state only.
   */
  askForChange: {
    experimental_description:
      "Each Change's Ask thread id, keyed by ChangeKey: the hidden thread the review page's Ask agent panel talks to, or null before the first question.",
    input: z.object({ keys: z.array(changeKeySchema).min(1).max(20) }).strict(),
    output: z.record(z.string(), z.object({ threadId: z.string().nullable() }).strict()),
    keyTags: (key: string) => [askTag(key as ChangeKey)],
  },
  /**
   * A question about the Change. The first one forks the Change's owning
   * thread (hidden) and stores it as the Change's Ask thread; later ones are
   * sent to that thread. Concurrent first questions fork once.
   */
  ask: {
    input: z
      .object({
        key: changeKeySchema,
        text: z.string().trim().min(1).max(20_000),
        path: z.string().min(1).max(4096).optional(),
        line: z.number().int().positive().optional(),
        /** The line is numbered before the change (a removed line). */
        old: z.boolean().optional(),
      })
      .strict(),
    output: askResultSchema,
  },
  /** "Open as full thread": unhides the Change's Ask thread. */
  openAskAsThread: {
    input: z.object({ key: changeKeySchema }).strict(),
    output: askResultSchema,
  },
  /**
   * The cutover: imports what the old code-review and gitbutler plugins keep
   * in their own storage, through their read-only exports. Idempotent by
   * natural key; safe to run twice and to resume. Never writes to them.
   */
  importFromOldPlugins: {
    experimental_description:
      "Import pins, review instructions, viewed marks, pull request watches and landed records from the old code-review and gitbutler plugins. Idempotent; reports counts per kind.",
    input: z.object({}).strict(),
    output: importReportSchema,
  },
  /**
   * An old `::code-review` card's target as a Change, keyed by
   * `pr:<owner>/<repo>#<n>` or `branch:<GitButler branch id>`.
   */
  legacyChange: {
    input: z.object({ keys: z.array(z.string().min(1).max(300)).min(1).max(25) }).strict(),
    output: z.record(
      z.string(),
      z
        .object({
          key: changeKeySchema.nullable(),
          /** Why there is no Change, when `key` is null. */
          problem: z.string().nullable(),
        })
        .strict(),
    ),
    keyTags: (key: string) => [`legacy:${key}`],
  },
  /** What a landed card lists, as GitHub reports it now. */
  landedCard: {
    input: landedTargetSchema,
    output: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), landed: landedSchema }).strict(),
      z.object({ ok: z.literal(false), message: z.string(), away: z.boolean() }).strict(),
    ]),
  },
  /** Pull requests pinned to the Changes list, newest first. */
  pins: {
    input: z.object({}).strict(),
    output: z.object({ pins: z.array(prRefSchema) }).strict(),
  },
  setPinned: {
    input: z.object({ ref: prRefSchema, pinned: z.boolean() }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  /** "Ask agent to fix" on a checkout a tool is missing from: a thread on that host to install it. */
  askToFix: {
    input: z.object({ threadId: threadIdSchema }).strict(),
    output: askResultSchema,
  },
  /** Writes the guide again for the Change's current head: "Rewrite guide" and "Try again". */
  rewriteGuide: {
    experimental_description:
      "Start a new guide run for the Change's current head, replacing the stored guide when it lands. Returns the run already writing when there is one.",
    input: z.object({ key: changeKeySchema }).strict(),
    output: guideViewSchema,
  },
  /** Marks one file viewed or not at its blob. Convergent. */
  setViewed: {
    input: z
      .object({
        key: changeKeySchema,
        path: z.string().min(1).max(4096),
        blob: z.string().min(1).max(64),
        viewed: z.boolean(),
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  /** The pull request's conversation, read on demand while the tab shows it. */
  changeConversation: {
    input: z.object({ key: changeKeySchema }).strict(),
    output: conversationResultSchema,
    tags: (input: { key: string }) => [changeTag(input.key as ChangeKey)],
  },
  /** Reads a GitButler workspace as plain git, or by what it is again. Stored per checkout. */
  setReadAs: {
    input: z.object({ threadId: threadIdSchema, readAs: z.enum(["auto", "git"]) }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
});
