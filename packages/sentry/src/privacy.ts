import type { ErrorEvent, Event, StackFrame } from "@sentry/node";

type TransactionEvent = Event & { type: "transaction" };

export const FIXED_EXCEPTION_MESSAGE = "Unexpected plugin callback failure";

const CONTROLLED_TAGS: readonly string[] = [
  "bb.plugin.id",
  "bb.kit.boundary",
  "bb.kit.operation",
  "bb.kit.variant",
  "bb.kit.outcome",
];

const CONTROLLED_TRACE_DATA: readonly string[] = [
  "sentry.origin",
  "sentry.op",
  "sentry.source",
  "sentry.sample_rate",
];

export function redactPluginError(error: unknown): Error {
  const redacted = new Error(FIXED_EXCEPTION_MESSAGE);
  redacted.name = "Error";
  if (error instanceof Error && error.stack !== undefined) {
    const [, ...frames] = error.stack.split(/\r?\n/u);
    redacted.stack = [`Error: ${FIXED_EXCEPTION_MESSAGE}`, ...frames].join("\n");
  }
  return redacted;
}

export function sanitizeSentryEvent(event: ErrorEvent): ErrorEvent {
  const exception = event.exception?.values?.[0];
  const frames = exception?.stacktrace?.frames?.map(sanitizeStackFrame);
  const debugImages = event.debug_meta?.images?.flatMap((image) => {
    if (
      image.type !== "sourcemap" ||
      typeof image.debug_id !== "string" ||
      !isDebugId(image.debug_id)
    ) {
      return [];
    }
    const codeFile = sanitizeFilename(image.code_file);
    if (codeFile === undefined) return [];
    return [{ type: "sourcemap" as const, code_file: codeFile, debug_id: image.debug_id }];
  });
  const tags: Record<string, string> = {};
  for (const key of CONTROLLED_TAGS) {
    const value = event.tags?.[key];
    if (typeof value === "string") {
      tags[key] = value;
    }
  }

  return {
    type: undefined,
    ...(event.event_id === undefined ? {} : { event_id: event.event_id }),
    ...(event.timestamp === undefined ? {} : { timestamp: event.timestamp }),
    ...(event.platform === undefined ? {} : { platform: event.platform }),
    ...(event.level === undefined ? {} : { level: event.level }),
    ...(event.release === undefined ? {} : { release: event.release }),
    ...(event.environment === undefined ? {} : { environment: event.environment }),
    ...(event.sdk?.name === undefined && event.sdk?.version === undefined
      ? {}
      : {
          sdk: {
            ...(event.sdk.name === undefined ? {} : { name: event.sdk.name }),
            ...(event.sdk.version === undefined ? {} : { version: event.sdk.version }),
          },
        }),
    ...(Object.keys(tags).length === 0 ? {} : { tags }),
    ...(debugImages === undefined || debugImages.length === 0
      ? {}
      : { debug_meta: { images: debugImages } }),
    exception: {
      values: [
        {
          type: "Error",
          value: FIXED_EXCEPTION_MESSAGE,
          ...(frames === undefined ? {} : { stacktrace: { frames } }),
        },
      ],
    },
  };
}

/** Performance events use only static operation names, controlled tags, trace
 * identifiers, and numeric measurements. In particular, they never carry a
 * request, cwd, thread id, prompt, tool input, breadcrumb, or user context. */
export function sanitizeSentryTransaction(event: TransactionEvent): TransactionEvent {
  const tags = controlledTags(event.tags);
  const trace = event.contexts?.trace;
  const traceData: Record<string, string | number | boolean> = {};
  for (const key of CONTROLLED_TRACE_DATA) {
    const value = trace?.data?.[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      traceData[key] = value;
    }
  }
  const measurements: NonNullable<TransactionEvent["measurements"]> = {};
  for (const [name, measurement] of Object.entries(event.measurements ?? {})) {
    if (!Number.isFinite(measurement.value) || typeof measurement.unit !== "string") continue;
    measurements[name] = { value: measurement.value, unit: measurement.unit };
  }

  return {
    type: "transaction",
    ...(event.event_id === undefined ? {} : { event_id: event.event_id }),
    ...(event.timestamp === undefined ? {} : { timestamp: event.timestamp }),
    ...(event.start_timestamp === undefined ? {} : { start_timestamp: event.start_timestamp }),
    ...(event.platform === undefined ? {} : { platform: event.platform }),
    ...(event.release === undefined ? {} : { release: event.release }),
    ...(event.environment === undefined ? {} : { environment: event.environment }),
    ...(event.sdk?.name === undefined && event.sdk?.version === undefined
      ? {}
      : {
          sdk: {
            ...(event.sdk.name === undefined ? {} : { name: event.sdk.name }),
            ...(event.sdk.version === undefined ? {} : { version: event.sdk.version }),
          },
        }),
    ...(event.transaction === undefined ? {} : { transaction: event.transaction }),
    ...(event.transaction_info === undefined ? {} : { transaction_info: event.transaction_info }),
    ...(Object.keys(tags).length === 0 ? {} : { tags }),
    ...(trace === undefined
      ? {}
      : {
          contexts: {
            trace: {
              trace_id: trace.trace_id,
              span_id: trace.span_id,
              ...(trace.parent_span_id === undefined
                ? {}
                : { parent_span_id: trace.parent_span_id }),
              ...(trace.op === undefined ? {} : { op: trace.op }),
              ...(trace.status === undefined ? {} : { status: trace.status }),
              ...(trace.origin === undefined ? {} : { origin: trace.origin }),
              ...(Object.keys(traceData).length === 0 ? {} : { data: traceData }),
            },
          },
        }),
    ...(Object.keys(measurements).length === 0 ? {} : { measurements }),
  };
}

function controlledTags(tags: TransactionEvent["tags"]): Record<string, string> {
  const controlled: Record<string, string> = {};
  for (const key of CONTROLLED_TAGS) {
    const value = tags?.[key];
    if (typeof value === "string") controlled[key] = value;
  }
  return controlled;
}

function sanitizeStackFrame(frame: StackFrame): StackFrame {
  const filename = sanitizeFilename(frame.filename ?? frame.abs_path);
  return {
    ...(filename === undefined ? {} : { filename }),
    ...(frame.function === undefined ? {} : { function: frame.function }),
    ...(frame.lineno === undefined ? {} : { lineno: frame.lineno }),
    ...(frame.colno === undefined ? {} : { colno: frame.colno }),
    ...(frame.in_app === undefined ? {} : { in_app: frame.in_app }),
  };
}

function sanitizeFilename(filename: string | undefined): string | undefined {
  if (filename === undefined || filename.length === 0) {
    return undefined;
  }
  if (filename.startsWith("node:") || filename.startsWith("bun:")) {
    return filename;
  }
  const normalized = filename.replaceAll("\\", "/").replace(/^file:\/\//u, "");
  for (const marker of ["/node_modules/", "/packages/", "/plugins/"]) {
    const index = normalized.lastIndexOf(marker);
    if (index !== -1) {
      return normalized.slice(index + 1);
    }
  }
  return normalized.split("/").at(-1);
}

function isDebugId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
}
