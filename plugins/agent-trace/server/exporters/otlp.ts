import type { ExportTraceServiceRequest, OtlpSpan } from "../turn-trace.ts";

export type TraceBackend = "laminar" | "langfuse";

export class ExportError extends Error {
  readonly backend: TraceBackend;
  readonly status: number;

  constructor(backend: TraceBackend, status: number) {
    super(`${backend} returned HTTP ${status}`);
    this.name = "ExportError";
    this.backend = backend;
    this.status = status;
  }
}

export interface OtlpTarget {
  backend: TraceBackend;
  headers: Record<string, string>;
  url: string;
}

export async function postOtlpJson(
  target: OtlpTarget,
  request: ExportTraceServiceRequest,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(target.url, {
    method: "POST",
    headers: { ...target.headers, "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });
  if (!response.ok) throw new ExportError(target.backend, response.status);
  await response.body?.cancel();
}

/** Keep only the spans and attributes one backend understands. */
export function mapSpans(
  request: ExportTraceServiceRequest,
  keepSpan: (span: OtlpSpan) => boolean,
  keepAttribute: (key: string) => boolean,
): ExportTraceServiceRequest | null {
  const resourceSpans = request.resourceSpans
    .map((resourceSpan) => ({
      ...resourceSpan,
      scopeSpans: resourceSpan.scopeSpans
        .map((scopeSpan) => ({
          ...scopeSpan,
          spans: scopeSpan.spans.filter(keepSpan).map((span): OtlpSpan => {
            const mapped: OtlpSpan = {
              attributes: span.attributes.filter((attribute) => keepAttribute(attribute.key)),
              endTimeUnixNano: span.endTimeUnixNano,
              kind: span.kind,
              name: span.name,
              spanId: span.spanId,
              startTimeUnixNano: span.startTimeUnixNano,
              status: span.status,
              traceId: span.traceId,
            };
            if (span.parentSpanId !== undefined) mapped.parentSpanId = span.parentSpanId;
            return mapped;
          }),
        }))
        .filter((scopeSpan) => scopeSpan.spans.length > 0),
    }))
    .filter((resourceSpan) => resourceSpan.scopeSpans.length > 0);
  return resourceSpans.length === 0 ? null : { resourceSpans };
}
