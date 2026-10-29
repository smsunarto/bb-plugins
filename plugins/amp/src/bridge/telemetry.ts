import { existsSync, readFileSync } from "node:fs";
import {
  NOOP_PERFORMANCE,
  sentryPluginEnvironment,
  sentryPerformanceReporter,
  type SentryPerformanceReporter,
} from "@bb-plugins/sentry/performance";
import {
  NOOP_REPORTER,
  sentryErrorReporter,
  type SentryPluginReporter,
} from "@bb-plugins/sentry/node";
import { AMP_SENTRY_ENV, ampSentryRelease } from "../../lib/telemetry.ts";

export const AMP_STARTUP_OPERATION = "cli.startup" as const;

export const AMP_STARTUP_CHECKPOINTS = [
  "attempt_entered",
  "execute_entered",
  "temp_files_ready",
  "spawn_called",
  "child_spawned",
  "first_stdout_byte",
  "input_written",
  "first_stdout_line",
  "first_valid_json",
  "process_closed",
  "unsupported_flag",
  "system_init",
  "first_model_event",
] as const;

export type AmpStartupCheckpoint = (typeof AMP_STARTUP_CHECKPOINTS)[number];
export type AmpStartupOutcome = "ok" | "error" | "cancelled" | "retry" | "incomplete";
export type AmpStartupExecutor = "local" | "orb";
export type AmpStartupContinuation = "fresh" | "continued";
export type AmpStartupMode = "low" | "medium" | "high" | "ultra";
export type AmpStartupVariant =
  `${AmpStartupExecutor}.${AmpStartupContinuation}.${"mcp" | "no-mcp"}.${AmpStartupMode}.attempt-${0 | 1}`;

export interface AmpExecutionTrace {
  checkpoint(name: AmpStartupCheckpoint): void;
  finish(outcome: AmpStartupOutcome): void;
}

export type AmpPerformanceReporter = SentryPerformanceReporter;
export type AmpErrorReporter = SentryPluginReporter;

export interface AmpStartupTraceContext {
  readonly executor: AmpStartupExecutor;
  readonly continuation: AmpStartupContinuation;
  readonly mcp: boolean;
  readonly mode: AmpStartupMode;
  readonly attempt: 0 | 1;
}

interface AmpHostMeta {
  readonly pluginId: string;
  readonly pluginVersion: string;
}

export function createAmpPerformanceReporter(
  pluginId: string,
  env: NodeJS.ProcessEnv = process.env,
  metaUrl?: URL,
): SentryPerformanceReporter {
  const dsn = env[AMP_SENTRY_ENV[0]]?.trim();
  if (dsn === undefined || dsn.length === 0) return NOOP_PERFORMANCE;
  try {
    const meta = readAmpHostMeta(metaUrl ?? resolveAmpHostMetaUrl());
    if (meta.pluginId !== pluginId) return NOOP_PERFORMANCE;
    return sentryPerformanceReporter({
      dsn,
      release: ampSentryRelease(meta),
      environment: sentryPluginEnvironment(env),
    })({ pluginId });
  } catch {
    return NOOP_PERFORMANCE;
  }
}

export function createAmpErrorReporter(
  pluginId: string,
  env: NodeJS.ProcessEnv = process.env,
  metaUrl?: URL,
): SentryPluginReporter {
  const dsn = env[AMP_SENTRY_ENV[0]]?.trim();
  if (dsn === undefined || dsn.length === 0) return NOOP_REPORTER;
  try {
    const identity = readAmpHostMeta(metaUrl ?? resolveAmpHostMetaUrl());
    if (identity.pluginId !== pluginId) return NOOP_REPORTER;
    return sentryErrorReporter({
      dsn,
      release: ampSentryRelease(identity),
      environment: sentryPluginEnvironment(env),
    })({ pluginId });
  } catch {
    return NOOP_REPORTER;
  }
}

export function startAmpStartupTrace(
  reporter: SentryPerformanceReporter,
  context: AmpStartupTraceContext,
): AmpExecutionTrace {
  return reporter.start({
    operation: AMP_STARTUP_OPERATION,
    variant: ampStartupVariant(context),
  });
}

export function ampStartupVariant(context: AmpStartupTraceContext): AmpStartupVariant {
  const transport = context.mcp ? "mcp" : "no-mcp";
  return `${context.executor}.${context.continuation}.${transport}.${context.mode}.attempt-${context.attempt}`;
}

export function createIdempotentShutdown(
  shutdown: () => void | Promise<void>,
): () => Promise<void> {
  let closing: Promise<void> | undefined;
  return () => {
    if (closing === undefined) {
      try {
        closing = Promise.resolve(shutdown());
      } catch (error) {
        closing = Promise.reject(error);
      }
    }
    return closing;
  };
}

function resolveAmpHostMetaUrl(): URL {
  const bundled = new URL("./host.meta.json", import.meta.url);
  if (existsSync(bundled)) return bundled;
  const sourceFallback = new URL("../../dist/host.meta.json", import.meta.url);
  if (existsSync(sourceFallback)) return sourceFallback;
  throw new Error("Amp host metadata is missing beside the host bundle and in dist");
}

function readAmpHostMeta(metaUrl: URL): AmpHostMeta {
  const parsed: unknown = JSON.parse(readFileSync(metaUrl, "utf8"));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { pluginId?: unknown }).pluginId !== "string" ||
    typeof (parsed as { pluginVersion?: unknown }).pluginVersion !== "string"
  ) {
    throw new Error("Amp host metadata has no plugin identity");
  }
  return parsed as AmpHostMeta;
}
