import { z } from "zod";
import { bodySchema, eventKindSchema, eventSchema, sessionSchema, topicSchema } from "./model.ts";

export const idSchema = z.string().min(1).max(512);
export const providerIdSchema = z.string().min(1).max(80);
export const sourceRootSchema = z
  .object({
    provider: providerIdSchema,
    path: z.string().min(1).max(16_384),
    enabled: z.boolean(),
  })
  .strict();
export const sourceStatusSchema = sourceRootSchema.extend({
  state: z.enum(["ready", "missing", "error", "scanning", "disabled"]),
  message: z.string().nullable(),
  fileCount: z.number().int().nonnegative(),
});
export const providerSchema = z.object({
  id: providerIdSchema,
  label: z.string(),
  version: z.number(),
});
export const hostSchema = z.object({ id: idSchema, name: z.string(), online: z.boolean() });
export const targetSchema = z.object({ hostId: idSchema }).strict();
export const sessionQuerySchema = z
  .object({
    provider: providerIdSchema.optional(),
    query: z.string().max(500).optional(),
    nativeId: z.string().max(512).optional(),
    cursor: z.string().max(4096).optional(),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();
export const eventQuerySchema = z
  .object({
    sessionId: idSchema,
    kind: eventKindSchema.optional(),
    topic: topicSchema.optional(),
    query: z.string().max(500).optional(),
    // Response usage records outnumber the work they measure, so the timeline
    // leaves them out until a reader asks for them.
    includeUsage: z.boolean().default(false),
    cursor: z.string().max(4096).optional(),
    limit: z.number().int().min(1).max(200).default(100),
  })
  .strict();
export const eventInputSchema = z.object({ eventId: idSchema }).strict();
export const rawInputSchema = eventInputSchema
  .extend({
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(262_144).default(65_536),
  })
  .strict();
export const scanInputSchema = z.object({ verify: z.boolean().default(false) }).strict();
export const configureInputSchema = z.object({ roots: z.array(sourceRootSchema).max(32) }).strict();
export const statusSchema = z.object({
  schemaVersion: z.literal(1),
  providers: z.array(providerSchema),
  roots: z.array(sourceStatusSchema),
  sessions: z.number().int().nonnegative(),
  events: z.number().int().nonnegative(),
  scanning: z.boolean(),
  lastScanAt: z.number().nullable(),
  lastError: z.string().nullable(),
  revision: z.number().int().nonnegative(),
});
export const sessionPageSchema = z.object({
  schemaVersion: z.literal(1),
  items: z.array(sessionSchema),
  nextCursor: z.string().nullable(),
  revision: z.number().int().nonnegative(),
});
export const eventPageSchema = z.object({
  schemaVersion: z.literal(1),
  items: z.array(eventSchema),
  nextCursor: z.string().nullable(),
  revision: z.number().int().nonnegative(),
});
export const eventDetailSchema = z.object({
  schemaVersion: z.literal(1),
  event: eventSchema.nullable(),
  body: bodySchema.nullable(),
  bodyTruncated: z.boolean(),
  sourceState: z.enum(["available", "missing", "changed", "unreadable"]),
  message: z.string().nullable(),
  related: z.array(eventSchema),
});
export const rawPageSchema = z.object({
  schemaVersion: z.literal(1),
  state: z.enum(["available", "missing", "changed", "unreadable"]),
  base64: z.string(),
  offset: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable(),
  message: z.string().nullable(),
});
export const overviewSchema = z.object({
  hosts: z.array(hostSchema),
  context: z
    .object({
      hostId: idSchema,
      provider: z.string(),
      nativeId: z.string().nullable(),
      title: z.string(),
    })
    .nullable(),
});
export type SourceRoot = z.infer<typeof sourceRootSchema>;
export type SourceStatus = z.infer<typeof sourceStatusSchema>;
export type TraceStatus = z.infer<typeof statusSchema>;
export type SessionQuery = z.infer<typeof sessionQuerySchema>;
export type EventQuery = z.infer<typeof eventQuerySchema>;
export type SessionPage = z.infer<typeof sessionPageSchema>;
export type EventPage = z.infer<typeof eventPageSchema>;
export type EventDetail = z.infer<typeof eventDetailSchema>;
export type RawInput = z.infer<typeof rawInputSchema>;
export type RawPage = z.infer<typeof rawPageSchema>;
