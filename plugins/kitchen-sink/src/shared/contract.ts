import { z } from "zod";
import { unityDiffSchema } from "./unity-diff.ts";

export const renderEmbedInputSchema = z
  .object({
    kind: z.enum(["code", "diff", "patch"]),
    threadId: z.string().min(1),
    messageId: z.string().min(1).optional(),
    /** Worktree-relative file. Optional for `patch`, which can infer it from a single-file patch. */
    path: z.string().max(1_024).optional(),
    /** Thread-storage-relative patch file. Only for `patch`. */
    file: z.string().min(1).max(1_024).optional(),
    start: z.number().int().positive().optional(),
    end: z.number().int().positive().optional(),
  })
  .strict();

export const renderEmbedOutputSchema = z.union([
  z
    .object({
      status: z.literal("ready"),
      kind: z.literal("code"),
      path: z.string(),
      label: z.string(),
      content: z.string(),
      startLine: z.number().int().positive(),
      truncated: z.boolean(),
    })
    .strict(),
  z
    .object({
      status: z.literal("ready"),
      kind: z.enum(["diff", "patch"]),
      path: z.string(),
      label: z.string(),
      patch: z.string(),
      unity: unityDiffSchema.optional(),
      unityNotice: z.string().optional(),
      truncated: z.boolean(),
    })
    .strict(),
  z
    .object({
      status: z.literal("empty"),
      message: z.string(),
    })
    .strict(),
  z
    .object({
      status: z.literal("error"),
      message: z.string(),
    })
    .strict(),
]);

export type RenderEmbedOutput = z.output<typeof renderEmbedOutputSchema>;

export type SmartEmbedsRpcContract = {
  readonly renderEmbed: {
    readonly input: typeof renderEmbedInputSchema;
    readonly output: typeof renderEmbedOutputSchema;
  };
};

export const prepareHtmlPreviewInputSchema = z.strictObject({
  threadId: z.string().trim().min(1),
  file: z.string().trim().min(1).max(1_024),
});

export const prepareHtmlPreviewOutputSchema = z.strictObject({ file: z.string() });

export type InlineVisRpcContract = {
  readonly prepareHtmlPreview: {
    readonly input: typeof prepareHtmlPreviewInputSchema;
    readonly output: typeof prepareHtmlPreviewOutputSchema;
  };
};

/**
 * Realtime channel the server publishes on when a thread's workspace may have
 * changed. The app drops or refreshes cached embeds for that thread.
 */
export const WORKSPACE_CHANGED_CHANNEL = "workspace-changed";

export const workspaceChangedSignalSchema = z
  .object({
    threadId: z.string().min(1),
    reason: z.enum(["idle", "failed", "archived", "deleted"]),
  })
  .strict();

export type WorkspaceChangedSignal = z.output<typeof workspaceChangedSignalSchema>;
