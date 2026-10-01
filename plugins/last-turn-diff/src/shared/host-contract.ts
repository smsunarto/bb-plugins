import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/**
 * - `start`: a provisional baseline taken at dispatch. The turn may never run
 *   (another plugin can queue it), so it never marks the thread as running.
 * - `open`: taken when the thread turns active. The thread is mid-turn.
 * - `end`: taken when the thread goes idle or fails. The thread is done.
 */
export type CaptureKind = "start" | "open" | "end";
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
/** Repository-relative files another thread may have written, for one capture pair. */
const attributionSchema = z.object({
  start: z.string(),
  end: z.string(),
  foreign: z.array(z.string()),
});
export type Attribution = z.infer<typeof attributionSchema>;
const snapshotPatchSchema = z.object({
  /** The environment path with symlinks resolved, as Git and providers report it. */
  root: z.string(),
  /** This thread's changes. Null when they exceed the preview limit. */
  patch: z.string().nullable(),
  /** Files that changed while another thread in the same checkout was mid-turn. */
  otherPatch: z.string().nullable(),
  limited: z.boolean(),
  /** Environment-relative submodule roots. Snapshots cannot see edits inside them. */
  uncovered: z.array(z.string()),
  attribution: attributionSchema,
});
export type SnapshotPatch = z.infer<typeof snapshotPatchSchema>;

export const snapshotHostContract = defineRpcContract({
  capture: {
    input: z.object({ ...target, at: time, kind: z.enum(["start", "open", "end"]) }).strict(),
    output: z.object({ captured: z.boolean() }),
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
  forget: { input: z.object(target).strict(), output: z.object({}) },
});
