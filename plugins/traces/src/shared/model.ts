import { z } from "zod";

export const eventKindSchema = z.enum([
  "message",
  "reasoning",
  "tool_call",
  "tool_result",
  "context",
  "turn",
  "usage",
  "diagnostic",
]);
export const topicSchema = z.enum([
  "instructions",
  "skills",
  "plugins",
  "sandbox",
  "subagents",
  "mcp",
  "search",
]);
export const evidenceSchema = z.object({
  topic: topicSchema,
  action: z.enum([
    "available",
    "loaded",
    "invoked",
    "requested",
    "blocked",
    "bypass_requested",
    "bypass_enabled",
    "result",
    "reference",
  ]),
  label: z.string(),
  basis: z.enum(["recorded", "inferred"]),
  pointer: z.string(),
});
export const toolSchema = z.object({
  name: z.string(),
  callId: z.string().nullable(),
  status: z.enum(["requested", "success", "error", "unknown"]),
});
export const usageSchema = z.object({
  input: z.number().nullable(),
  output: z.number().nullable(),
  cached: z.number().nullable(),
  scope: z.enum(["response", "turn", "session"]),
});
export const bodySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string(),
    format: z.enum(["markdown", "plain", "code"]),
    language: z.string().optional(),
  }),
  z.object({
    type: z.literal("tool"),
    input: z.unknown(),
    output: z.unknown(),
    text: z.string().nullable(),
  }),
  z.object({
    type: z.literal("context"),
    name: z.string(),
    content: z.string(),
    format: z.enum(["markdown", "plain", "json"]),
    captured: z.boolean(),
  }),
  z.object({ type: z.literal("data"), value: z.unknown() }),
]);
export const eventFieldsSchema = z.object({
  kind: eventKindSchema,
  role: z.enum(["user", "assistant", "developer", "system", "tool"]).nullable(),
  title: z.string(),
  preview: z.string(),
  timestamp: z.number().nullable(),
  template: z.string(),
  nativeId: z.string().nullable(),
  parentId: z.string().nullable(),
  turnId: z.string().nullable(),
  tool: toolSchema.nullable(),
  usage: usageSchema.nullable(),
  evidence: z.array(evidenceSchema),
});
export const provenanceSchema = z.object({
  path: z.string(),
  line: z.number(),
  pointer: z.string(),
  byteOffset: z.number(),
  byteLength: z.number(),
  recordHash: z.string(),
  adapterVersion: z.number(),
});
export const eventSchema = eventFieldsSchema.extend({
  id: z.string(),
  sessionId: z.string(),
  provider: z.string(),
  sequence: z.number(),
  part: z.number(),
  provenance: provenanceSchema,
});
export const sessionSchema = z.object({
  id: z.string(),
  nativeId: z.string().nullable(),
  provider: z.string(),
  title: z.string(),
  path: z.string(),
  cwd: z.string().nullable(),
  model: z.string().nullable(),
  parentNativeId: z.string().nullable(),
  startedAt: z.number().nullable(),
  updatedAt: z.number(),
  eventCount: z.number(),
  toolCount: z.number(),
  errorCount: z.number(),
  topics: z.array(topicSchema),
  state: z.enum(["ready", "indexing", "missing", "error"]),
});
export type TraceEvent = z.infer<typeof eventSchema>;
export type TraceSession = z.infer<typeof sessionSchema>;
export type TraceBody = z.infer<typeof bodySchema>;
export type TraceEvidence = z.infer<typeof evidenceSchema>;
export type ParsedEvent = z.infer<typeof eventFieldsSchema> & { pointer: string; body: TraceBody };
export type SessionPatch = {
  nativeId?: string;
  title?: string;
  cwd?: string;
  model?: string;
  parentNativeId?: string;
  startedAt?: number;
};
export type ParsedRecord = { session: SessionPatch; events: ParsedEvent[] };
export interface TraceAdapter {
  readonly id: string;
  readonly label: string;
  readonly version: number;
  roots(home: string, env: Readonly<Record<string, string | undefined>>): string[];
  accepts(path: string): boolean;
  parse(record: unknown, context: { path: string; line: number }): ParsedRecord;
}
