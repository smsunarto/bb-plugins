import { defineRpcContract } from "@get-bb/plugin-sdk";
import type {
  ExperimentalAiInferenceCompleteInput,
  ExperimentalAiInferenceCompleteOutput,
  ExperimentalAiServiceErrorCode,
  ExperimentalAiVoiceTranscribeInput,
  ExperimentalAiVoiceTranscribeOutput,
} from "@get-bb/plugin-sdk/ai-services";
import type { JsonValue } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { gitButlerHostContract } from "./gitbutler.ts";

export const GTD_SIDEBAR_AI_SERVICE_ID = "gtd-sidebar";

export type GtdSidebarAiInferenceCompleteInput = Omit<
  ExperimentalAiInferenceCompleteInput,
  "reasoningEffort"
> & {
  reasoningEffort: "none" | "low";
};

// bb 0.41 aliases every @get-bb/plugin-sdk import in a server source graph to
// its root runtime file. That alias also catches /ai-services and turns it into
// the invalid path plugin-sdk-runtime.js/ai-services. Keep the SDK as the type
// authority while defining the equivalent runtime contract inside the plugin.
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
]) satisfies z.ZodType<ExperimentalAiServiceErrorCode>;
const aiServiceFailureSchema = z
  .object({
    ok: z.literal(false),
    code: aiServiceErrorCodeSchema,
    message: z.string().min(1),
  })
  .strict();
const aiInferenceCompleteInputSchema = z
  .object({
    serviceId: z.string().min(1),
    model: z.string().min(1),
    reasoningEffort: z.enum(["none", "low"]),
    prompt: z.string().min(1),
    outputSchema: jsonObjectSchema,
    timeoutMs: z.number().int().positive(),
  })
  .strict() satisfies z.ZodType<GtdSidebarAiInferenceCompleteInput>;
const aiInferenceCompleteOutputSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      model: z.string().min(1),
      value: jsonObjectSchema,
    })
    .strict(),
  aiServiceFailureSchema,
]) satisfies z.ZodType<ExperimentalAiInferenceCompleteOutput>;
const aiVoiceTranscribeInputSchema = z
  .object({
    serviceId: z.string().min(1),
    model: z.string().min(1),
    audioBase64: z.string().min(1),
    mimeType: z.string().min(1),
    filename: z.string().min(1),
    prompt: z.string().nullable(),
    timeoutMs: z.number().int().positive(),
  })
  .strict() satisfies z.ZodType<ExperimentalAiVoiceTranscribeInput>;
const aiVoiceTranscribeOutputSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      model: z.string().min(1),
      text: z.string(),
    })
    .strict(),
  aiServiceFailureSchema,
]) satisfies z.ZodType<ExperimentalAiVoiceTranscribeOutput>;

const gtdSidebarAiServicesHostContract = defineRpcContract({
  "ai.inference.complete": {
    input: aiInferenceCompleteInputSchema,
    output: aiInferenceCompleteOutputSchema,
  },
  "ai.voice.transcribe": {
    input: aiVoiceTranscribeInputSchema,
    output: aiVoiceTranscribeOutputSchema,
  },
});

export const gtdSidebarHostContract = defineRpcContract({
  ...gitButlerHostContract,
  ...gtdSidebarAiServicesHostContract,
});

export type GtdSidebarAiInferenceCompleteOutput = ExperimentalAiInferenceCompleteOutput;
export type GtdSidebarAiServiceErrorCode = ExperimentalAiServiceErrorCode;
export type GtdSidebarAiVoiceTranscribeInput = ExperimentalAiVoiceTranscribeInput;
export type GtdSidebarAiVoiceTranscribeOutput = ExperimentalAiVoiceTranscribeOutput;
