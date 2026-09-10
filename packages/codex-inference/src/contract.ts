import type { JsonValue } from "@get-bb/plugin-sdk";
import { z } from "zod";

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);
const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

const aiServiceErrorCodeSchema = z.enum([
  "timeout",
  "rate_limited",
  "service_unavailable",
  "auth_required",
  "request_failed",
  "invalid_response",
]);

export const aiInferenceCompleteInputSchema = z.strictObject({
  model: z.string().min(1),
  reasoningEffort: z.enum(["none", "low", "medium", "high", "xhigh"]).optional(),
  prompt: z.string().min(1),
  outputSchema: jsonObjectSchema,
  timeoutMs: z.number().int().positive(),
});

export const aiInferenceCompleteOutputSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    model: z.string().min(1),
    value: jsonObjectSchema,
  }),
  z.strictObject({
    ok: z.literal(false),
    code: aiServiceErrorCodeSchema,
    message: z.string().min(1),
  }),
]);

export type CodexInferenceInput = z.infer<typeof aiInferenceCompleteInputSchema>;
export type CodexInferenceOutput = z.infer<typeof aiInferenceCompleteOutputSchema>;
export type CodexInferenceErrorCode = z.infer<typeof aiServiceErrorCodeSchema>;
