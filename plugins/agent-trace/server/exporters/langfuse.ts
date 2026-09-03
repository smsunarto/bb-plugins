import type { LangfuseConfig } from "../../shared/settings.ts";
import type { ExportTraceServiceRequest, OtlpSpan } from "../turn-trace.ts";
import { mapSpans, postOtlpJson } from "./otlp.ts";

const LANGFUSE_OTLP_PATH = "/api/public/otel/v1/traces";

function isLaminarInternal(span: OtlpSpan): boolean {
  return span.attributes.some(
    (attribute) =>
      attribute.key === "lmnr.internal.metadata_only" ||
      attribute.key === "bb.backfill.content_carrier",
  );
}

/**
 * Langfuse maps `langfuse.*` first and falls back to `gen_ai.*`. Usage and
 * message keys are dropped so the explicit Langfuse buckets and OpenAI-format
 * messages are the only source, and Laminar-only keys stay out of metadata.
 */
export function langfuseRequest(
  request: ExportTraceServiceRequest,
): ExportTraceServiceRequest | null {
  return mapSpans(
    request,
    (span) => !isLaminarInternal(span),
    (key) =>
      !key.startsWith("lmnr.") &&
      !key.startsWith("gen_ai.usage.") &&
      !key.startsWith("llm.usage.") &&
      key !== "gen_ai.input.messages" &&
      key !== "gen_ai.output.messages",
  );
}

export function langfuseTracesUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${LANGFUSE_OTLP_PATH}`;
}

export async function exportToLangfuse(
  config: LangfuseConfig,
  request: ExportTraceServiceRequest,
  signal?: AbortSignal,
): Promise<void> {
  const credentials = Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64");
  await postOtlpJson(
    {
      backend: "langfuse",
      url: langfuseTracesUrl(config.baseUrl),
      headers: {
        Authorization: `Basic ${credentials}`,
        "x-langfuse-ingestion-version": "4",
      },
    },
    request,
    signal,
  );
}
