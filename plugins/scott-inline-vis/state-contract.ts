import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const MAX_STATE_BYTES = 16 * 1024;
export const MAX_STATE_MENTION_ID_LENGTH = 40_000;

const identifierSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !value.includes("\0"), {
    message: "Identifier must not contain a null byte",
  });

export const absoluteFileSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) => !value.includes("\0") && /^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(value),
    { message: "Visualization file must be an absolute path without null bytes" },
  );

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
  file: absoluteFileSchema,
});

const widgetStateValuesSchema = widgetIdentitySchema.extend({
  state: jsonStateSchema,
  modelContent: jsonStateSchema.nullable(),
  tweaks: jsonStateSchema.nullable(),
});

export const saveWidgetStateSchema = widgetStateValuesSchema
  .partial({ state: true, modelContent: true, tweaks: true })
  .extend({
    /** Legacy migration fills absent widget state without replacing saved widget state. */
    ifMissing: z.boolean().optional(),
    /** Omitted means full replacement. An empty list reads the existing snapshot. */
    fields: z
      .array(z.enum(["state", "tweaks"]))
      .max(2)
      .refine((fields) => new Set(fields).size === fields.length, "Write fields must be unique")
      .optional(),
  })
  .superRefine((input, context) => {
    const fullWrite = input.ifMissing === true || input.fields === undefined;
    const selectedState = fullWrite || input.fields?.includes("state");
    const selectedTweaks = fullWrite || input.fields?.includes("tweaks");
    for (const field of ["state", "modelContent", "tweaks"] as const) {
      const selected = field === "tweaks" ? selectedTweaks : selectedState;
      if (selected && input[field] === undefined) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${field} is required for this write`,
        });
      } else if (!fullWrite && input.fields?.length === 0 && input[field] !== undefined) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: "Context-only reads must omit state fields",
        });
      }
    }
  });

export const widgetStateSnapshotSchema = widgetStateValuesSchema.extend({
  /** Null means an older JSON-null row has unknown widget-state history. */
  hasWidgetState: z.boolean().nullable(),
  savedAt: z.iso.datetime(),
  mentionId: z.string().min(1).max(MAX_STATE_MENTION_ID_LENGTH),
});

export type WidgetIdentity = z.infer<typeof widgetIdentitySchema>;
export type SaveWidgetState = z.infer<typeof saveWidgetStateSchema>;
export type WidgetStateSnapshot = z.infer<typeof widgetStateSnapshotSchema>;

export const stateContract = defineRpcContract({
  saveState: {
    input: saveWidgetStateSchema,
    output: widgetStateSnapshotSchema,
  },
  readState: {
    input: widgetIdentitySchema,
    output: widgetStateSnapshotSchema.nullable(),
  },
});
