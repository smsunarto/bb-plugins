import { promisify } from "node:util";
import { gzip } from "node:zlib";
import type { NeatlogsConfig } from "./settings.ts";
import type { NeatlogsSpan } from "./turn-trace.ts";

const REQUEST_TIMEOUT_MS = 30_000;
const gzipAsync = promisify(gzip);

/**
 * What the pump does with a turn after one POST:
 * - `exported`: advance the checkpoint.
 * - `blocked`: the ingest firewall refused the body's content. It answers with
 *   an HTML 403, unlike the JSON errors of Neatlogs's own API, and trips on
 *   ordinary agent text such as `../` paths, local URLs, and HTML. Gzipped
 *   bodies pass it, so this is rare; resend the turn without content.
 * - `rejected`: Neatlogs will never accept this body (400/413/422); advance
 *   past it so one bad turn cannot block the thread.
 * - `refused`: the key or URL is wrong (401/403/404); hold every export until
 *   the settings change.
 * - `retry`: keep the checkpoint and try again shortly (any other failure).
 */
export type ExportOutcome =
  | { kind: "exported"; traceId: string; spans: number }
  | { kind: "blocked" }
  | { kind: "rejected"; status: number }
  | { kind: "refused"; status: number }
  | { kind: "retry"; reason: string };

const REJECTED_STATUSES = new Set([400, 413, 422]);
const REFUSED_STATUSES = new Set([401, 403, 404]);

export type TraceExporter = (
  config: NeatlogsConfig,
  trace: NeatlogsSpan,
  signal: AbortSignal,
) => Promise<ExportOutcome>;

function outcomeForResponse(response: Response): ExportOutcome {
  const { status } = response;
  const json = response.headers.get("content-type")?.includes("json") ?? false;
  if (status === 403 && !json) return { kind: "blocked" };
  if (REJECTED_STATUSES.has(status)) return { kind: "rejected", status };
  if (REFUSED_STATUSES.has(status)) return { kind: "refused", status };
  return { kind: "retry", reason: `HTTP ${status}` };
}

/**
 * POST one nested trace to Neatlogs `/v1/trace`, which assigns its IDs. The
 * body is gzipped: it shrinks large tool output, and the ingest firewall does
 * not inspect compressed bodies, so ordinary agent text no longer trips it.
 */
export const postTrace: TraceExporter = async (config, trace, signal) => {
  const body = await gzipAsync(JSON.stringify(trace));
  let response: Response;
  try {
    response = await fetch(config.traceUrl, {
      method: "POST",
      headers: {
        "content-encoding": "gzip",
        "content-type": "application/json",
        "x-api-key": config.apiKey,
      },
      body,
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    return { kind: "retry", reason: error instanceof Error ? error.name : "network error" };
  }
  if (!response.ok) {
    await response.body?.cancel();
    return outcomeForResponse(response);
  }
  const result = (await response.json().catch(() => null)) as {
    trace_id?: unknown;
    spans?: unknown;
  } | null;
  return {
    kind: "exported",
    traceId: typeof result?.trace_id === "string" ? result.trace_id : "unknown",
    spans: typeof result?.spans === "number" ? result.spans : 0,
  };
};
