import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** Longest message the panel and CLI accept, in characters. */
export const MAX_TEXT_LENGTH = 8_000;
/** Characters of a message kept in the send log. */
export const LOG_TEXT_PREVIEW = 200;
/** Entries the send log keeps; older ones fall off. */
export const LOG_LIMIT = 200;
/** Reads of the send log refresh when the server invalidates this tag. */
export const SEND_LOG_TAG = "send-log";

export const botSchema = z.object({ id: z.string(), name: z.string() }).strict();
export type Bot = z.output<typeof botSchema>;

/**
 * What the browser may learn about the config file. The webhook URL and
 * key never appear here: they stay on the server.
 */
export const statusSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("ready"),
      configPath: z.string(),
      bots: z.array(botSchema),
    })
    .strict(),
  z
    .object({
      state: z.enum(["missing", "invalid", "insecure"]),
      configPath: z.string(),
      reason: z.string(),
    })
    .strict(),
]);
export type GrokbotStatus = z.output<typeof statusSchema>;

export const threadContextSchema = z
  .object({
    thread_id: z.string(),
    project: z.string().nullable(),
    branch: z.string().nullable(),
  })
  .strict();
export type ThreadContext = z.output<typeof threadContextSchema>;

export const actionSchema = z.enum(["message", "ping"]);
export type GrokbotAction = z.output<typeof actionSchema>;

export const sendInputSchema = z
  .object({
    action: actionSchema,
    targetBot: z.string().min(1).nullable().optional(),
    text: z.string().max(MAX_TEXT_LENGTH).optional(),
    /** Fill `context` from this bb thread; the server resolves its project and branch. */
    threadId: z.string().min(1).nullable().optional(),
  })
  .strict();
export type SendInput = z.input<typeof sendInputSchema>;

export const outcomeSchema = z
  .object({
    ok: z.boolean(),
    /** HTTP status, or null when no response arrived. */
    status: z.number().int().nullable(),
    /** Why the send failed, without the URL or key. */
    error: z.string().nullable(),
    durationMs: z.number(),
  })
  .strict();
export type SendOutcome = z.output<typeof outcomeSchema>;

export const logEntrySchema = z
  .object({
    id: z.string(),
    ts: z.string(),
    action: actionSchema,
    target_bot: z.string().nullable(),
    textPreview: z.string(),
    context: threadContextSchema.nullable(),
    ok: z.boolean(),
    status: z.number().int().nullable(),
    error: z.string().nullable(),
    durationMs: z.number(),
  })
  .strict();
export type LogEntry = z.output<typeof logEntrySchema>;

export const contract = defineRpcContract({
  status: { input: z.null(), output: statusSchema },
  threadContext: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: threadContextSchema.extend({ title: z.string().nullable() }),
  },
  send: {
    input: sendInputSchema,
    output: z
      .object({ outcome: outcomeSchema, entry: logEntrySchema, logged: z.boolean() })
      .strict(),
  },
  log: {
    input: z
      .object({ limit: z.number().int().min(1).max(LOG_LIMIT).optional() })
      .strict()
      .nullable(),
    output: z.object({ entries: z.array(logEntrySchema) }).strict(),
    tags: () => [SEND_LOG_TAG],
  },
});
