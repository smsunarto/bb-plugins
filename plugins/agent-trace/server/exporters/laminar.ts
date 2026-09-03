import { createHash } from "node:crypto";
import type { LaminarConfig } from "../../shared/settings.ts";
import type { ExportTraceServiceRequest, OtlpSpan } from "../turn-trace.ts";
import { mapSpans, postOtlpJson } from "./otlp.ts";

function isMetadataOnly(span: OtlpSpan): boolean {
  return span.attributes.some(
    (attribute) =>
      attribute.key === "lmnr.internal.metadata_only" && attribute.value.boolValue === true,
  );
}

/** Laminar reads `lmnr.*` and `gen_ai.*`; Langfuse-only keys would clutter its span metadata. */
export function laminarRequest(
  request: ExportTraceServiceRequest,
): ExportTraceServiceRequest | null {
  return mapSpans(
    request,
    () => true,
    (key) => !key.startsWith("langfuse."),
  );
}

export function traceIoOnly(request: ExportTraceServiceRequest): ExportTraceServiceRequest | null {
  return mapSpans(request, isMetadataOnly, () => true);
}

export function traceIoBackfill(
  request: ExportTraceServiceRequest,
): ExportTraceServiceRequest | null {
  const patch = traceIoOnly(request);
  if (patch === null) return null;

  const spans = request.resourceSpans.flatMap((resourceSpan) =>
    resourceSpan.scopeSpans.flatMap((scopeSpan) => scopeSpan.spans),
  );
  const root = spans.find((span) => span.parentSpanId === undefined);
  const output = root?.attributes.find((attribute) => attribute.key === "lmnr.span.output");
  if (root === undefined || output?.value.stringValue === undefined) return patch;

  const hex = createHash("sha256")
    .update(`bb-laminar:v1:trace-output-backfill-span:${root.traceId}`)
    .digest("hex")
    .slice(0, 16);
  const carrier: OtlpSpan = {
    traceId: root.traceId,
    spanId: /^0+$/.test(hex) ? `${hex.slice(0, -1)}1` : hex,
    parentSpanId: root.spanId,
    name: "bb.trace.output.backfill",
    kind: 1,
    startTimeUnixNano: root.endTimeUnixNano,
    endTimeUnixNano: root.endTimeUnixNano,
    attributes: [
      { key: "lmnr.span.type", value: { stringValue: "LLM" } },
      { key: "lmnr.span.instrumentation_source", value: { stringValue: "bb-plugin-agent-trace" } },
      { key: "bb.backfill.content_carrier", value: { boolValue: true } },
      output,
    ],
    status: { code: 1 },
  };
  patch.resourceSpans[0]?.scopeSpans[0]?.spans.unshift(carrier);
  return patch;
}

export async function exportToLaminar(
  config: LaminarConfig,
  request: ExportTraceServiceRequest,
  signal?: AbortSignal,
): Promise<void> {
  await postOtlpJson(
    {
      backend: "laminar",
      url: config.endpoint,
      headers: { Authorization: `Bearer ${config.apiKey}` },
    },
    request,
    signal,
  );
}
