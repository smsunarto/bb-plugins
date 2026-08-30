import type { ErrorEvent, StackFrame } from "@sentry/node";

export const FIXED_EXCEPTION_MESSAGE = "Unexpected plugin callback failure";

const CONTROLLED_TAGS: readonly string[] = ["bb.plugin.id", "bb.kit.boundary", "bb.kit.operation"];

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
