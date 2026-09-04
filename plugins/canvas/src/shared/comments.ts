import { z } from "zod";
import { canvasSourceSchema } from "./document.ts";

// The only module that spells the sidecar file and the comments rpc shapes.
// The app imports it type-only; zod-free helpers live in anchor.ts and ids.ts.

export type Author = "user" | "agent";

export interface Anchor {
  /** 12 hex of fnv1a64(normalized blockText). Not unique. */
  readonly blockId: string;
  /** Ordinal in the flattened walk at write time. A drift hint only. */
  readonly index: number;
  /** Exact selected substring of the block, or null for the whole block. */
  readonly quote: string | null;
  /** blockText capped at 240 chars. Shown when the thread is detached. */
  readonly preview: string;
}

export interface CommentMessage {
  readonly id: string;
  readonly author: Author;
  readonly body: string;
  readonly createdAtMs: number;
}

export interface CommentThread {
  readonly id: string;
  readonly anchor: Anchor;
  readonly resolvedAtMs: number | null;
  readonly messages: readonly [CommentMessage, ...CommentMessage[]];
}

export interface CommentsFile {
  readonly version: 1;
  readonly threads: readonly CommentThread[];
}

export type CommentOp =
  | { readonly op: "open"; readonly thread: CommentThread }
  | { readonly op: "reply"; readonly threadId: string; readonly message: CommentMessage }
  | { readonly op: "resolve"; readonly threadId: string; readonly resolved: boolean };

export const previewLength = 240;

export const authorSchema = z.enum(["user", "agent"]);

export const anchorSchema: z.ZodType<Anchor, Anchor> = z.object({
  blockId: z.string().regex(/^[0-9a-f]{12}$/),
  index: z.number().int().nonnegative(),
  quote: z.string().min(1).nullable(),
  preview: z.string().max(previewLength),
});

export const commentMessageSchema: z.ZodType<CommentMessage, CommentMessage> = z.object({
  id: z.string().min(1),
  author: authorSchema,
  body: z.string().min(1),
  createdAtMs: z.number(),
});

export const commentThreadSchema: z.ZodType<CommentThread, CommentThread> = z.object({
  id: z.string().regex(/^cmt_[a-z0-9]{10}$/),
  anchor: anchorSchema,
  resolvedAtMs: z.number().nullable(),
  messages: z.tuple([commentMessageSchema], commentMessageSchema),
});

export const commentsFileSchema: z.ZodType<CommentsFile, CommentsFile> = z.object({
  version: z.literal(1),
  threads: z.array(commentThreadSchema),
});

export const emptyCommentsFile: CommentsFile = { version: 1, threads: [] };

export const commentOpSchema: z.ZodType<CommentOp, CommentOp> = z.discriminatedUnion("op", [
  z.object({ op: z.literal("open"), thread: commentThreadSchema }),
  z.object({ op: z.literal("reply"), threadId: z.string().min(1), message: commentMessageSchema }),
  z.object({ op: z.literal("resolve"), threadId: z.string().min(1), resolved: z.boolean() }),
]);

export const commentsInputSchema = z.object({
  source: canvasSourceSchema,
  knownSha256: z.string().nullable().default(null),
});

export const commentsOutputSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("unchanged"), sha256: z.string() }),
  z.object({
    status: z.literal("loaded"),
    sha256: z.string().nullable(),
    file: commentsFileSchema,
    malformed: z.boolean(),
  }),
]);

export type CommentsOutput = z.infer<typeof commentsOutputSchema>;

export const commentInputSchema = z.object({
  source: canvasSourceSchema,
  op: commentOpSchema,
});

export const commentOutputSchema = z.object({
  sha256: z.string(),
  file: commentsFileSchema,
});

export type CommentOutput = z.infer<typeof commentOutputSchema>;
