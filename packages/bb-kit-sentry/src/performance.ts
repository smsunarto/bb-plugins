import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { sanitizeSentryTransaction } from "./privacy.ts";

export type SentryPerformanceReporterOptions = Readonly<{
  dsn?: string;
  release?: string;
  environment?: string;
  /** Defaults to 1 because the DSN itself is the opt-in switch and plugin
   * startup traces are low-volume. */
  tracesSampleRate?: number;
}>;

export type PerformanceTraceOutcome = "ok" | "error" | "cancelled" | "retry" | "incomplete";

export interface PerformanceTrace {
  /** Record elapsed milliseconds from start. The first mark with a given name
   * wins, which makes "first stdout" checkpoints honest. */
  checkpoint(name: string): void;
  /** Idempotent. The Sentry envelope is sent only after this call. */
  finish(outcome: PerformanceTraceOutcome): void;
}

export interface SentryPerformanceReporter {
  start(args: Readonly<{ operation: string; variant?: string }>): PerformanceTrace;
  dispose(timeoutMs: number): Promise<void>;
}

interface SentryEnvelopeTarget {
  readonly dsn: string;
  readonly endpoint: string;
}

interface CompletedTrace {
  readonly pluginId: string;
  readonly operation: string;
  readonly variant?: string;
  readonly outcome: PerformanceTraceOutcome;
  readonly startedAtEpochMs: number;
  readonly finishedAtEpochMs: number;
  readonly checkpoints: ReadonlyMap<string, number>;
}

export function sentryPerformanceReporter(
  options: SentryPerformanceReporterOptions,
): (context: Readonly<{ pluginId: string }>) => SentryPerformanceReporter | undefined {
  return ({ pluginId }) => {
    const dsn = options.dsn?.trim();
    if (dsn === undefined || dsn.length === 0) return undefined;
    const target = parseEnvelopeTarget(dsn);
    if (target === undefined) return undefined;

    let closing: Promise<void> | undefined;
    let disposed = false;
    const pending = new Set<Promise<void>>();
    const requests = new Set<AbortController>();
    const sampleRate = normalizeSampleRate(options.tracesSampleRate);

    return {
      start({ operation, variant }) {
        const startedAtEpochMs = Date.now();
        const startedAtMonotonicMs = performance.now();
        const checkpoints = new Map<string, number>();
        const sampled = Math.random() < sampleRate;
        let finished = false;
        return {
          checkpoint(name) {
            if (finished || checkpoints.has(name)) return;
            checkpoints.set(name, performance.now() - startedAtMonotonicMs);
          },
          finish(outcome) {
            if (finished) return;
            finished = true;
            const elapsedMs = performance.now() - startedAtMonotonicMs;
            checkpoints.set("total", elapsedMs);
            if (disposed || !sampled) return;
            const request = new AbortController();
            requests.add(request);
            const task = sendCompletedTrace(
              target,
              options,
              {
                pluginId,
                operation,
                ...(variant === undefined ? {} : { variant }),
                outcome,
                startedAtEpochMs,
                finishedAtEpochMs: startedAtEpochMs + elapsedMs,
                checkpoints,
              },
              request.signal,
            ).catch(() => undefined);
            pending.add(task);
            void task.then(() => {
              pending.delete(task);
              requests.delete(request);
              return undefined;
            });
          },
        };
      },
      dispose(timeoutMs) {
        if (closing === undefined) {
          disposed = true;
          closing = (async () => {
            if (pending.size === 0) return;
            let timeout: ReturnType<typeof setTimeout> | undefined;
            const timedOut = new Promise<"timeout">((resolve) => {
              timeout = setTimeout(() => resolve("timeout"), Math.max(0, timeoutMs));
            });
            const completed = Promise.all(pending).then(() => "completed" as const);
            if ((await Promise.race([completed, timedOut])) === "timeout") {
              for (const request of requests) request.abort();
            }
            if (timeout !== undefined) clearTimeout(timeout);
            await Promise.all(pending);
          })();
        }
        return closing;
      },
    };
  };
}

async function sendCompletedTrace(
  target: SentryEnvelopeTarget,
  options: SentryPerformanceReporterOptions,
  trace: CompletedTrace,
  signal: AbortSignal,
): Promise<void> {
  const measurements: Record<string, { value: number; unit: "millisecond" }> = {};
  for (const [checkpoint, elapsedMs] of trace.checkpoints) {
    measurements[`bb.${checkpoint}`] = { value: elapsedMs, unit: "millisecond" };
  }
  const eventId = randomHex(16);
  const event = sanitizeSentryTransaction({
    type: "transaction",
    event_id: eventId,
    transaction: `${trace.pluginId}.${trace.operation}`,
    transaction_info: { source: "custom" },
    start_timestamp: trace.startedAtEpochMs / 1_000,
    timestamp: trace.finishedAtEpochMs / 1_000,
    platform: "node",
    ...(options.release === undefined ? {} : { release: options.release }),
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    tags: {
      "bb.plugin.id": trace.pluginId,
      "bb.kit.operation": trace.operation,
      ...(trace.variant === undefined ? {} : { "bb.kit.variant": trace.variant }),
      "bb.kit.outcome": trace.outcome,
    },
    contexts: {
      trace: {
        trace_id: randomHex(16),
        span_id: randomHex(8),
        op: "bb.plugin.performance",
        status: statusFor(trace.outcome),
      },
    },
    measurements,
  });
  const body = [
    JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString(), dsn: target.dsn }),
    JSON.stringify({ type: "transaction" }),
    JSON.stringify(event),
  ].join("\n");
  const response = await fetch(target.endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-sentry-envelope" },
    body,
    signal,
  });
  await response.arrayBuffer();
  if (!response.ok)
    throw new Error(`Sentry rejected the performance envelope (${response.status})`);
}

function parseEnvelopeTarget(dsn: string): SentryEnvelopeTarget | undefined {
  try {
    const parsed = new URL(dsn);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username.length === 0
    ) {
      return undefined;
    }
    const pathname = parsed.pathname.replace(/\/+$/u, "");
    const separator = pathname.lastIndexOf("/");
    const projectId = pathname.slice(separator + 1);
    if (projectId.length === 0) return undefined;
    const prefix = pathname.slice(0, separator);
    const auth = new URLSearchParams({
      sentry_version: "7",
      sentry_key: decodeURIComponent(parsed.username),
    });
    const endpoint = `${parsed.protocol}//${parsed.host}${prefix}/api/${projectId}/envelope/?${auth}`;
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return { dsn: parsed.toString(), endpoint };
  } catch {
    return undefined;
  }
}

function normalizeSampleRate(rate: number | undefined): number {
  if (rate === undefined) return 1;
  if (!Number.isFinite(rate)) return 0;
  return Math.min(1, Math.max(0, rate));
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function statusFor(
  outcome: PerformanceTraceOutcome,
): "ok" | "cancelled" | "internal_error" | "unknown_error" {
  switch (outcome) {
    case "ok":
      return "ok";
    case "cancelled":
    case "retry":
      return "cancelled";
    case "error":
      return "internal_error";
    case "incomplete":
      return "unknown_error";
  }
}
