import { z } from "zod";
import { isHtmlRenderPageId } from "./html-render.ts";

export const MAX_STATE_BYTES = 16 * 1024;
/** Mention provider for saved state pills, shared by the app and server. */
export const WIDGET_STATE_MENTION_PROVIDER = "widget-state";
export const MAX_STATE_MENTION_ID_LENGTH = 40_000;

const identifierSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !value.includes("\0"), {
    message: "Identifier must not contain a null byte",
  });

/** Saved state belongs to a page `html_render` published, within one message. */
export const pageIdSchema = z.string().refine(isHtmlRenderPageId, {
  message: "Expected a page id that html_render returned",
});

/** JSON crosses the RPC boundary as text so arbitrary fragment state stays opaque. */
export const jsonStateSchema = z
  .string()
  .max(MAX_STATE_BYTES)
  .refine((value) => new TextEncoder().encode(value).length <= MAX_STATE_BYTES, {
    message: "Visualization JSON must be at most 16 KiB",
  })
  .refine(
    (value) => {
      try {
        JSON.parse(value);
        return true;
      } catch {
        return false;
      }
    },
    { message: "Visualization state must be valid JSON" },
  );

export const widgetIdentitySchema = z.strictObject({
  threadId: identifierSchema,
  messageId: identifierSchema,
  pageId: pageIdSchema,
});

const widgetStateValuesSchema = widgetIdentitySchema.extend({
  state: jsonStateSchema,
  modelContent: jsonStateSchema.nullable(),
  tweaks: jsonStateSchema.nullable(),
});

export const saveWidgetStateSchema = widgetStateValuesSchema
  .partial({ state: true, modelContent: true, tweaks: true })
  .extend({
    /** Omitted means full replacement. An empty list reads the existing snapshot. */
    fields: z
      .array(z.enum(["state", "tweaks"]))
      .max(2)
      .refine((fields) => new Set(fields).size === fields.length, "Write fields must be unique")
      .optional(),
  })
  .superRefine((input, context) => {
    const fullWrite = input.fields === undefined;
    for (const field of ["state", "modelContent", "tweaks"] as const) {
      const selected = fullWrite || input.fields?.includes(field === "tweaks" ? "tweaks" : "state");
      if (selected && input[field] === undefined) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${field} is required for this write`,
        });
      } else if (input.fields?.length === 0 && input[field] !== undefined) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: "Context-only reads must omit state fields",
        });
      }
    }
  });

export const widgetStateSnapshotSchema = widgetStateValuesSchema.extend({
  /** False when only Tweak changes were saved. */
  hasWidgetState: z.boolean(),
  savedAt: z.iso.datetime(),
  mentionId: z.string().min(1).max(MAX_STATE_MENTION_ID_LENGTH),
});

export type WidgetIdentity = z.infer<typeof widgetIdentitySchema>;
export type SaveWidgetState = z.infer<typeof saveWidgetStateSchema>;
export type WidgetStateSnapshot = z.infer<typeof widgetStateSnapshotSchema>;
