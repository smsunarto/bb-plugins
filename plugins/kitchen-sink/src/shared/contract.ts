import { z } from "zod";

export const renderEmbedInputSchema = z
  .object({
    kind: z.enum(["code", "diff"]),
    threadId: z.string().min(1),
    path: z.string().min(1).max(1_024),
    start: z.number().int().positive().optional(),
    end: z.number().int().positive().optional(),
  })
  .strict();

export const renderEmbedOutputSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ready"),
      kind: z.enum(["code", "diff"]),
      path: z.string(),
      label: z.string(),
      patch: z.string(),
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
