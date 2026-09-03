import type { LangfuseConfig } from "../../shared/settings.ts";
import type { ExportTraceServiceRequest, OtlpSpan } from "../turn-trace.ts";
import { ExportError, mapSpans, postOtlpJson } from "./otlp.ts";

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

/** Langfuse redirects `/trace/<id>` to the owning project's trace page. */
export function langfuseTraceUrl(baseUrl: string, traceId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/trace/${traceId}`;
}

function basicAuth(config: LangfuseConfig): string {
  return `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64")}`;
}

export interface LangfuseObservation {
  endTime?: string | null;
  id: string;
  input?: unknown;
  name: string;
  output?: unknown;
  parentObservationId?: string | null;
  model?: string | null;
  startTime: string;
  type: string;
  usageDetails?: Record<string, number> | null;
}

/** Read one trace back through the v2 observations API (the v3 trace endpoint is deprecated). */
export async function fetchLangfuseObservations(
  config: LangfuseConfig,
  traceId: string,
  signal?: AbortSignal,
): Promise<LangfuseObservation[]> {
  const url = new URL(`${config.baseUrl.replace(/\/+$/, "")}/api/public/v2/observations`);
  url.searchParams.set("traceId", traceId);
  url.searchParams.set("fields", "core,basic,io,model,usage");
  url.searchParams.set("limit", "1000");
  const response = await fetch(url, {
    headers: { accept: "application/json", authorization: basicAuth(config) },
    signal,
  });
  if (!response.ok) throw new ExportError("langfuse", response.status);
  const body = (await response.json()) as { data?: LangfuseObservation[] };
  return body.data ?? [];
}

export async function exportToLangfuse(
  config: LangfuseConfig,
  request: ExportTraceServiceRequest,
  signal?: AbortSignal,
): Promise<void> {
  await postOtlpJson(
    {
      backend: "langfuse",
      url: langfuseTracesUrl(config.baseUrl),
      headers: {
        Authorization: basicAuth(config),
        "x-langfuse-ingestion-version": "4",
      },
    },
    request,
    signal,
  );
}
