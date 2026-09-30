import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export type CaptureKind = "start" | "end";
const target = {
  environmentPath: z.string().min(1).max(4096),
  threadId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
};
const snapshotPatchSchema = z.object({
  /** The environment path with symlinks resolved, as Git and providers report it. */
  root: z.string(),
  /** This thread's changes. Null when they exceed the preview limit. */
  patch: z.string().nullable(),
  /** Files that changed while another thread in the same checkout was mid-turn. */
  otherPatch: z.string().nullable(),
  limited: z.boolean(),
});
export type SnapshotPatch = z.infer<typeof snapshotPatchSchema>;

export const snapshotHostContract = defineRpcContract({
  capture: {
    input: z
      .object({
        ...target,
        at: z.number().int().nonnegative(),
        kind: z.enum(["start", "end"]),
      })
      .strict(),
    output: z.object({ captured: z.boolean() }),
  },
  turnPatch: {
    input: z
      .object({
        ...target,
        startedAt: z.number().int().nonnegative(),
        completedAt: z.number().int().nonnegative(),
        /** File paths the provider recorded editing, absolute or environment-relative. */
        recordedPaths: z.array(z.string().max(4096)).max(1000),
      })
      .strict(),
    output: z.object({ snapshot: snapshotPatchSchema.nullable() }),
  },
  forget: { input: z.object(target).strict(), output: z.object({}) },
});
