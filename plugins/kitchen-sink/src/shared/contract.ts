import { z } from "zod";
import { unityCitationSchema } from "@bb-plugins/unity-inspector/model";

const embedFields = {
  threadId: z.string().min(1),
  path: z.string().min(1).max(1024),
  start: z.number().int().positive().optional(),
  end: z.number().int().positive().optional(),
};
/** A workspace other than the message thread's own: project name or id, environment id, or thread id. */
const workspaceField = { workspace: z.string().trim().min(1).max(200).optional() };
export const renderEmbedInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("code"), ...embedFields, ...workspaceField }),
  z.strictObject({
    kind: z.literal("diff"),
    ...embedFields,
    ...workspaceField,
    messageId: z.string().min(1),
    turnId: z.string().min(1).optional(),
    source: z.enum(["turn", "workspace", "commit"]).optional(),
    sha: z
      .string()
      .regex(/^[a-fA-F0-9]{40}$/)
      .optional(),
  }),
  z.strictObject({
    kind: z.literal("patch"),
    ...embedFields,
    path: z.string().max(1024).optional(),
    file: z.string().min(1).max(1024),
  }),
]);
export type RenderEmbedInput = z.output<typeof renderEmbedInputSchema>;
export const diffEmbedSchema = z.strictObject({
  status: z.literal("ready"),
  kind: z.enum(["diff", "patch"]),
  path: z.string(),
  label: z.string(),
  patch: z.string(),
  source: z.string(),
  files: z.array(z.strictObject({ path: z.string(), patch: z.string() })).optional(),
  truncated: z.boolean(),
});
export const renderEmbedOutputSchema = z.union([
  diffEmbedSchema,
  z.strictObject({
    status: z.literal("ready"),
    kind: z.literal("code"),
    path: z.string(),
    label: z.string(),
    content: z.string(),
    startLine: z.number().int().positive(),
    truncated: z.boolean(),
    /** Set when the file was read from a workspace other than the message thread's. */
    workspace: z.string().optional(),
    unity: unityCitationSchema.optional(),
    unityNotice: z.string().optional(),
  }),
  z.strictObject({ status: z.literal("empty"), message: z.string() }),
  z.strictObject({ status: z.literal("error"), message: z.string() }),
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

export const prepareHtmlPreviewOutputSchema = z.strictObject({
  file: z.string(),
  html: z.string(),
});

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
