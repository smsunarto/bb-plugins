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
const changeFields = {
  status: z.literal("ready"),
  label: z.string(),
  source: z.string(),
  /** One entry per changed file. A diff, or a proposal narrowed to a path, has one. */
  files: z.array(z.strictObject({ path: z.string(), patch: z.string() })).min(1),
  truncated: z.boolean(),
};
export const diffEmbedSchema = z.strictObject({ kind: z.literal("diff"), ...changeFields });
const patchEmbedSchema = z.strictObject({ kind: z.literal("patch"), ...changeFields });
const codeEmbedSchema = z.strictObject({
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
});
const emptySchema = z.strictObject({ status: z.literal("empty"), message: z.string() });
const errorSchema = z.strictObject({ status: z.literal("error"), message: z.string() });
/** What each request kind gets back. One method carries their union; the app narrows it once. */
export const codeOutputSchema = z.union([codeEmbedSchema, errorSchema]);
export const diffOutputSchema = z.union([diffEmbedSchema, emptySchema, errorSchema]);
export const patchOutputSchema = z.union([patchEmbedSchema, emptySchema, errorSchema]);
export const renderEmbedOutputSchema = z.union([
  codeOutputSchema,
  diffOutputSchema,
  patchOutputSchema,
]);
export type RenderEmbedOutput = z.output<typeof renderEmbedOutputSchema>;
export type OutputFor<K extends RenderEmbedInput["kind"]> = K extends "code"
  ? z.output<typeof codeOutputSchema>
  : K extends "diff"
    ? z.output<typeof diffOutputSchema>
    : z.output<typeof patchOutputSchema>;
export type SmartEmbedsRpcContract = {
  readonly renderEmbed: {
    readonly input: typeof renderEmbedInputSchema;
    readonly output: typeof renderEmbedOutputSchema;
  };
};

/**
 * Realtime channel the server publishes on when a thread's workspace may have
 * changed. The app drops or refreshes cached embeds for that thread, and plays
 * the completion sound when a top-level thread becomes `idle`.
 */
export const WORKSPACE_CHANGED_CHANNEL = "workspace-changed";

export const workspaceChangedSignalSchema = z
  .object({
    threadId: z.string().min(1),
    parentThreadId: z.string().min(1).nullable(),
    reason: z.enum(["idle", "failed", "archived", "deleted"]),
  })
  .strict();

export type WorkspaceChangedSignal = z.output<typeof workspaceChangedSignalSchema>;

/** Plugin http route (under `/api/v1/plugins/<id>/http`) that serves the turn completion sound. */
export const COMPLETION_SOUND_PATH = "/completion-sound";
