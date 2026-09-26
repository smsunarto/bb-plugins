import { z } from "zod";
import { canvasSourceSchema, unreadableReasons } from "./document.ts";

// The MDX editor's file contract. Reads poll with the last known hash so an
// unchanged file costs one hash comparison; saves are compare-and-swap.

export const fileInputSchema = z.object({
  source: canvasSourceSchema,
  knownSha256: z.string().nullable().default(null),
});

export const fileOutputSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("unchanged"), sha256: z.string() }),
  z.object({ status: z.literal("read"), sha256: z.string(), content: z.string() }),
  z.object({
    status: z.literal("unreadable"),
    reason: z.enum(unreadableReasons),
    detail: z.string(),
  }),
]);

export type FileOutput = z.infer<typeof fileOutputSchema>;

export const previewInputSchema = z.object({ source: canvasSourceSchema });

// `baseUrl` serves the file's root directory; `path` is the file relative to it,
// so the editor can resolve relative images and HTML embeds.
export const previewOutputSchema = z.object({
  baseUrl: z.string().min(1),
  expiresAtMs: z.number().nonnegative(),
  path: z.string(),
});

export const saveInputSchema = z.object({
  source: canvasSourceSchema,
  content: z.string(),
  // Writes only over this version. Omit it to overwrite whatever is on disk.
  expectedSha256: z.string().optional(),
});

export const saveOutputSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("written"), sha256: z.string() }),
  z.object({ outcome: z.literal("conflict") }),
]);

export type SaveOutput = z.infer<typeof saveOutputSchema>;
