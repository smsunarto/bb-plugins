import { z } from "zod";
import { generationJob } from "./generation.ts";
import { gameSchema, idSchema, workspaceSchema } from "./schema.ts";

/*
 * A workspace read is one host call. The host reads the game's canvas files
 * where they live and hands back content-addressed entries, keyed by what
 * they are: `file:<path>`, `list:<folder>`, `job:<id>`, and `jobs`. The
 * server keeps the last answer per game and sends its fingerprint, so an
 * unchanged canvas comes back as one line and a changed one as only the
 * entries that differ from it.
 */

const relativePath = z.string().min(1).max(1000);
export const canvasFile = z.strictObject({
  content: z.string(),
  contentEncoding: z.enum(["utf8", "base64"]),
  sha256: z.string(),
  sizeBytes: z.number().int().nonnegative(),
});
export const canvasEntry = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("file"), file: canvasFile }),
  z.strictObject({ kind: z.literal("missing") }),
  /** A file too large to carry in a workspace read. */
  z.strictObject({
    kind: z.literal("oversized"),
    sha256: z.string(),
    sizeBytes: z.number().int().nonnegative(),
  }),
  /** Project-relative files below a folder, as BB's file listing finds them. */
  z.strictObject({
    kind: z.literal("listing"),
    files: z.array(relativePath).max(10_000),
    truncated: z.boolean(),
  }),
  z.strictObject({ kind: z.literal("job"), job: generationJob }),
  /** Where generation jobs were read, and whether the runner could vouch for their status. */
  z.strictObject({
    kind: z.literal("jobs"),
    workspacePath: z.string().nullable(),
    stale: z.boolean(),
  }),
]);
export type CanvasEntry = z.infer<typeof canvasEntry>;
export type CanvasFile = z.infer<typeof canvasFile>;

export const canvasRead = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("unchanged"), fingerprint: z.string() }),
  z.strictObject({
    status: z.literal("changed"),
    fingerprint: z.string(),
    /** The fingerprint these entries change, or null when they are the whole canvas. */
    base: z.string().nullable(),
    entries: z.record(z.string(), canvasEntry),
    removed: z.array(z.string()),
    /**
     * Only part of the change fit one host result. `fingerprint` names that
     * part, and a read from it sends the rest.
     */
    more: z.literal(true).optional(),
  }),
]);
export type CanvasRead = z.infer<typeof canvasRead>;

/** A canvas file that changed on disk, with its new content hash, or null when it is gone or not a file. */
export const canvasChange = z.strictObject({ path: z.string(), sha256: z.string().nullable() });
export type CanvasChange = z.infer<typeof canvasChange>;
/** How many changes a signal names before it only says that something changed. */
export const changeLimit = 200;

export const canvasHostContract = {
  readCanvas: {
    input: z.strictObject({
      rootPath: z.string().min(1),
      kind: gameSchema.shape.kind,
      since: z.string().optional(),
      /** Keep the canvas watched for the game an open studio shows. */
      watch: z.strictObject({ gameId: idSchema }).optional(),
    }),
    output: canvasRead,
  },
  saveCanvasBoard: {
    input: z.strictObject({
      rootPath: z.string().min(1),
      boardId: idSchema,
      expected: z.strictObject({ content: z.string(), layout: z.string().nullable() }),
      content: z.string(),
      layout: z.string(),
    }),
    output: z.strictObject({ content: z.string(), layout: z.string() }),
  },
  captureCanvasInputs: {
    input: z.strictObject({ rootPath: z.string().min(1), paths: z.array(relativePath).max(64) }),
    output: z.strictObject({
      inputs: z
        .array(z.strictObject({ path: z.string(), snapshot: z.string(), sha256: z.string() }))
        .max(64),
    }),
  },
  /** Frees the files of finished generations nothing on the canvas uses. */
  collectCanvas: {
    input: z.strictObject({ rootPath: z.string().min(1) }),
    output: z.strictObject({
      deleted: z.array(z.string()),
      /** Catalogued staged files that are gone, for the catalog to forget. */
      missing: z.array(z.string()),
      skipped: z.string().optional(),
    }),
  },
} as const;

export const studioHostSignals = {
  /** A watched canvas changed on disk. `changes` is null when there were too many to name. */
  canvasChanged: {
    payload: z.strictObject({
      gameId: idSchema,
      changes: z.array(canvasChange).max(changeLimit).nullable(),
    }),
  },
} as const;

/** What the app hears when a game's workspace may have changed. */
export const workspaceChangedChannel = "workspace-changed";
export const workspaceChanged = z.union([
  studioHostSignals.canvasChanged.payload,
  /** A BB run this plugin started finished; studios showing its job read again. */
  z.strictObject({ threadId: z.string() }),
]);
export type WorkspaceChanged = z.infer<typeof workspaceChanged>;

export const syncWorkspaceInput = z.strictObject({
  gameId: idSchema,
  since: z.string().optional(),
});
export const syncedWorkspace = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("unchanged"), fingerprint: z.string() }),
  z.strictObject({
    status: z.literal("changed"),
    fingerprint: z.string(),
    workspace: workspaceSchema,
  }),
]);

/** Where a game's library assets live, which the asset catalog lists. */
export function canvasAssetRoots(kind: z.infer<typeof gameSchema.shape.kind>): string[] {
  return kind === "unity" ? ["canvas/staging", "Assets/GameStudio"] : ["assets"];
}
