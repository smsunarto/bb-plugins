import { defineRpcContract } from "@get-bb/plugin-sdk";
import type { JsonValue } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { gitButlerHostContract } from "./gitbutler.ts";

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

const aiInferenceCompleteInputSchema = z.strictObject({
  model: z.string().min(1),
  prompt: z.string().min(1),
  outputSchema: jsonObjectSchema,
  timeoutMs: z.number().int().positive(),
});

const aiInferenceCompleteOutputSchema = z.union([
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

/**
 * The plugin's own host entry. Thread naming runs on the host because that is
 * where the user's Codex login lives; the GitButler probe runs there because
 * that is where the checkout is.
 */
export const gtdSidebarHostContract = defineRpcContract({
  ...gitButlerHostContract,
  "ai.inference.complete": {
    input: aiInferenceCompleteInputSchema,
    output: aiInferenceCompleteOutputSchema,
  },
});

export type GtdSidebarAiInferenceCompleteInput = z.infer<typeof aiInferenceCompleteInputSchema>;
export type GtdSidebarAiInferenceCompleteOutput = z.infer<typeof aiInferenceCompleteOutputSchema>;
export type GtdSidebarAiServiceErrorCode = z.infer<typeof aiServiceErrorCodeSchema>;
