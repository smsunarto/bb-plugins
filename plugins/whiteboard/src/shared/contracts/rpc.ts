import { z } from "zod";
import { AgentSelectionSchema } from "../review/agent-selection.ts";
import { fileLineRangeSchema } from "../review/source.ts";

/**
 * Input schemas of the app's RPC methods. `server.ts` assembles the contract
 * with each method's output type; `command` reuses the server's command
 * schema there. Every session input carries the canonical `sessionId`
 * (`info.sessionId`, never the "scratchpad" alias) and the panel's
 * `threadId`, which scopes the thread's scratchpad.
 */

const threadId = z.string().min(1).optional();
const sessionId = z.string().min(1);
const version = z.number().int().nonnegative();
/** A worktree comparison's source generation: `pins.worktreeRevision`. */
const generation = z.string().regex(/^[a-f0-9]{64}$/);
/** Read at a reference's own pins instead of the session's target. */
const anchor = {
  repositoryId: z.string().min(1).optional(),
  head: z.string().min(1).optional(),
  base: z.string().min(1).optional(),
};

/** Live-read tags. `liveSession` reads carry their session's tag and `live-session`. */
export const CATALOG_TAG = "catalog";
export const LIVE_SESSION_TAG = "live-session";
export const sessionTag = (id: string) => `session:${id}`;

export const coverageModeSchema = z.enum(["structural", "textual"]);
export type CoverageMode = z.infer<typeof coverageModeSchema>;

export const infoInput = z.strictObject({
  threadId: z.string().optional(),
  sessionId: z.string().optional(),
});
export type InfoInput = z.infer<typeof infoInput>;

export const infoOutput = z.object({
  /** Canonical identity for a thread-scoped alias, including restored legacy tabs. */
  sessionId: z.string().optional(),
  appVersion: z.string(),
  softwareMapEnabled: z.boolean(),
  scratchpadEnabled: z.boolean(),
  /** diffr found on the session's (or thread's) host. */
  structuralDiffEnabled: z.boolean(),
});
export type InfoOutput = z.infer<typeof infoOutput>;

/** How long an agent's open waits for a client of its thread to focus the tab. */
export const PENDING_OPEN_TTL_MS = 5 * 60_000;

/**
 * Read the focus an agent's open left for a thread. `after` is the newest
 * open the client focused there: the server forgets opens up to it, so each
 * focuses once, and answers only a newer one.
 */
export const claimOpenInput = z.strictObject({
  threadId: z.string().min(1),
  after: z.number().optional(),
});
export const claimOpenOutput = z.object({
  /**
   * Null when no newer open is waiting, it is older than 5 minutes, or its tab
   * was closed. `at` orders opens per thread, as `whiteboard:open` does.
   */
  open: z.object({ sessionId: z.string(), title: z.string(), at: z.number() }).nullable(),
});
export type PendingOpen = NonNullable<z.infer<typeof claimOpenOutput>["open"]>;

/**
 * Resolves a session file to the live file bb opens in its file opener.
 * `target` is null when the file has no live copy (commit or retained
 * sources), so the panel keeps it in-panel.
 */
export const liveFileInput = z.strictObject({
  threadId,
  sessionId: z.string().min(1),
  version: version.optional(),
  generation: z.string().min(1).optional(),
  path: z.string().min(1).max(4096),
  repositoryId: z.string().optional(),
  head: z.string().optional(),
  base: z.string().optional(),
});
export type LiveFileInput = z.infer<typeof liveFileInput>;

export const liveFileOutput = z.object({
  target: z.object({ kind: z.literal("host"), hostId: z.string(), path: z.string() }).nullable(),
});
export type LiveFileOutput = z.infer<typeof liveFileOutput>;

/** Home's catalog rows. A live read tagged `catalog`. */
export const sessionsInput = z.strictObject({ threadId, mode: coverageModeSchema });

/** The current document with its activity and coverage revision. A live read. */
export const liveSessionInput = z.strictObject({ threadId, sessionId });

/** One stored version, its pins probed: never invalidated, re-keyed by version. */
export const sessionVersionInput = z.strictObject({ threadId, sessionId, version });

export const historyInput = z.strictObject({ threadId, sessionId });

export const stackInput = z.strictObject({ threadId, sessionId, version: version.optional() });

export const commitsInput = z.strictObject({ threadId, sessionId, version: version.optional() });

export const mapInput = z.strictObject({
  threadId,
  sessionId,
  resourceId: z.string().min(1),
  version: version.optional(),
  generation: generation.optional(),
});

/** An uploaded image or trace, answered as base64 bytes. */
export const resourceInput = z.strictObject({
  threadId,
  sessionId,
  resourceId: z.string().min(1),
});

/** Coverage without waiting: a pending comparison answers its partial progress. */
export const progressInput = z.strictObject({
  threadId,
  sessionId,
  version: version.optional(),
  mode: coverageModeSchema,
  generation: generation.optional(),
});

/** Mark files viewed or unviewed at `version`, by their fingerprints. */
export const progressUpdateSchema = z.strictObject({
  mode: coverageModeSchema,
  version,
  files: z
    .array(
      z.strictObject({
        path: z.string(),
        fingerprint: z.string().min(1),
        sources: z.array(fileLineRangeSchema),
      }),
    )
    .max(10000),
  viewed: z.boolean(),
});
export type ProgressUpdate = z.infer<typeof progressUpdateSchema>;

export const markProgressInput = progressUpdateSchema.extend({ threadId, sessionId });

/** "Add to chat" and copy: the selection's clipboard text and bb handoff. */
export const copyContextInput = z.strictObject({
  threadId,
  sessionId,
  version: version.optional(),
  selection: AgentSelectionSchema,
});

/** The changed files of the session's comparison, a commit in it, or explicit pins. */
export const diffFilesInput = z.strictObject({
  threadId,
  sessionId,
  version: version.optional(),
  generation: generation.optional(),
  commit: z.string().min(1).optional(),
  ...anchor,
});

/** One whole source file. `projection: "comparison"` reads the comparison's retained head. */
export const fileInput = diffFilesInput.extend({
  side: z.enum(["base", "head"]),
  path: z.string().min(1),
  projection: z.enum(["raw", "comparison"]).optional(),
});
