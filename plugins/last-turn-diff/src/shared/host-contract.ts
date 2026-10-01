import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/**
 * - `start`: a turn's baseline, taken while the dispatch hook held the turn
 *   back. Only pinned once the turn really began.
 * - `open`: taken when the thread turns active. The thread is mid-turn.
 * - `run`: the thread turned active but its `open` snapshot failed. A
 *   lifecycle marker only, like `stop`.
 * - `end`: taken after the turn. Only proven to precede the next turn when
 *   that turn's `start` finished after it.
 * - `stop`: the thread finished but its `end` capture failed. A lifecycle
 *   marker only: it points at an older commit and never bounds a diff.
 */
export type CaptureKind = "start" | "open" | "run" | "end" | "stop";
const target = {
  environmentPath: z.string().min(1).max(4096),
  threadId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
};
const time = z.number().int().nonnegative();
/** bb's turn boundaries on the server clock. */
const windowSchema = z.object({
  /** The previous turn's completion, or 0 when this is the first turn. */
  prevCompletedAt: time,
  startedAt: time,
  completedAt: time,
  /** The next turn's start, or null when none has started. */
  nextStartedAt: time.nullable(),
});
export type TurnWindow = z.infer<typeof windowSchema>;
/**
 * Repository-relative files that changed only while another thread in the
 * checkout was mid-turn, for one capture pair. The turn's own recorded edits
 * are subtracted on every read, so late-arriving provider evidence still wins.
 */
export const attributionSchema = z.object({
  start: z.string(),
  end: z.string(),
  contested: z.array(z.string()),
  /** Contested paths some read found recorded by this turn. Ownership only grows. */
  owned: z.array(z.string()),
});
export type Attribution = z.infer<typeof attributionSchema>;
const snapshotPatchSchema = z.object({
  /** The environment path with symlinks resolved, as Git and providers report it. */
  root: z.string(),
  /** The environment path as the server knows it, before resolving symlinks. */
  path: z.string(),
  /** This thread's changes. Null when they exceed the preview limit. */
  patch: z.string().nullable(),
  /** Files that changed while another thread in the same checkout was mid-turn. */
  otherPatch: z.string().nullable(),
  limited: z.boolean(),
  /**
   * Environment-relative paths snapshots cannot see: submodule roots, and
   * recorded files Git ignores.
   */
  uncovered: z.array(z.string()),
  attribution: attributionSchema,
});
export type SnapshotPatch = z.infer<typeof snapshotPatchSchema>;

const commit = z.string().regex(/^[0-9a-f]{40,64}$/);
const pinSchema = z.object({
  kind: z.enum(["start", "open", "run", "end", "stop"]),
  /** Server clock when the capture began and when its snapshot returned. */
  at: time,
  finishedAt: time,
  /** Null for a marker: the host points it at the thread's latest capture. */
  commit: commit.nullable(),
});
export type Pin = z.infer<typeof pinSchema>;

export const snapshotHostContract = defineRpcContract({
  /** Record the checkout's files as a commit. Pins nothing: the server decides what it proves. */
  snapshot: {
    input: z.object({ environmentPath: target.environmentPath }).strict(),
    output: z.object({ commit: commit.nullable() }),
  },
  pin: {
    input: z.object({ ...target, captures: z.array(pinSchema).min(1).max(4) }).strict(),
    output: z.object({}),
  },
  turnPatch: {
    input: z
      .object({
        ...target,
        window: windowSchema,
        /** File paths the provider recorded editing, absolute or environment-relative. */
        recordedPaths: z.array(z.string().max(4096)).max(1000),
        /** A previous answer for this turn. Reused when its capture pair still matches. */
        known: attributionSchema.optional(),
      })
      .strict(),
    output: z.object({ snapshot: snapshotPatchSchema.nullable() }),
  },
  forget: { input: z.object({ ...target, at: time }).strict(), output: z.object({}) },
});
