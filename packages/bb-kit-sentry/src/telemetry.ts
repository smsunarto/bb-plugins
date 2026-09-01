import { existsSync, readFileSync } from "node:fs";
import { sentryErrorReporter } from "./node.ts";
import { sentryPerformanceReporter } from "./performance.ts";

/** Opt-in switches read from the environment where bb runs the plugin. */
export const SENTRY_PLUGIN_ENV = [
  "SENTRY_DSN",
  "SENTRY_ENVIRONMENT",
  "SENTRY_TRACES_SAMPLE_RATE",
] as const;

/** Per-call traces are chattier than startup traces, so sample conservatively. */
const DEFAULT_TRACES_SAMPLE_RATE = 0.1;

export interface SentryPluginArtifactIdentity {
  readonly pluginId: string;
  readonly pluginVersion: string;
}

export function sentryPluginRelease(identity: SentryPluginArtifactIdentity): string {
  return `bb-plugin-${identity.pluginId}@${identity.pluginVersion}`;
}

export type SentryPluginTelemetryOptions = Readonly<{
  pluginId: string;
  /**
   * `import.meta.url` of the plugin's server entry. The release is read
   * from the `server.meta.json` sidecar beside the built bundle (or in
   * `../dist` when running from source), never hardcoded.
   */
  serverEntryUrl: string | URL;
  env?: NodeJS.ProcessEnv;
  /** Used when SENTRY_TRACES_SAMPLE_RATE is unset. Defaults to 0.1. */
  tracesSampleRate?: number;
}>;

export interface SentryPluginTelemetry {
  readonly errorReporter: ReturnType<typeof sentryErrorReporter>;
  readonly performanceReporter: ReturnType<typeof sentryPerformanceReporter>;
}

const DISABLED: SentryPluginTelemetry = {
  errorReporter: () => undefined,
  performanceReporter: () => undefined,
};

/**
 * One-call wiring for `definePlugin`. Telemetry stays disabled unless
 * SENTRY_DSN is set where bb runs, the built artifact metadata is
 * readable, and its plugin id matches — a partial or drifted install
 * reports nothing rather than reporting under a wrong release.
 */
export function sentryPluginTelemetry(options: SentryPluginTelemetryOptions): SentryPluginTelemetry {
  try {
    const env = options.env ?? process.env;
    const dsn = env.SENTRY_DSN?.trim();
    if (dsn === undefined || dsn.length === 0) return DISABLED;
    const identity = readServerArtifactIdentity(options.serverEntryUrl);
    if (identity.pluginId !== options.pluginId) return DISABLED;
    const shared = {
      dsn,
      release: sentryPluginRelease(identity),
      ...(env.SENTRY_ENVIRONMENT === undefined ? {} : { environment: env.SENTRY_ENVIRONMENT }),
    };
    return {
      errorReporter: sentryErrorReporter(shared),
      performanceReporter: sentryPerformanceReporter({
        ...shared,
        tracesSampleRate: resolveTracesSampleRate(
          env.SENTRY_TRACES_SAMPLE_RATE,
          options.tracesSampleRate,
        ),
      }),
    };
  } catch {
    return DISABLED;
  }
}

function resolveTracesSampleRate(fromEnv: string | undefined, fallback: number | undefined): number {
  if (fromEnv !== undefined && fromEnv.trim().length > 0) {
    const parsed = Number(fromEnv);
    if (Number.isFinite(parsed)) return Math.min(1, Math.max(0, parsed));
  }
  return fallback ?? DEFAULT_TRACES_SAMPLE_RATE;
}

function readServerArtifactIdentity(serverEntryUrl: string | URL): SentryPluginArtifactIdentity {
  const bundled = new URL("./server.meta.json", serverEntryUrl);
  const sourceFallback = new URL("../dist/server.meta.json", serverEntryUrl);
  const metaUrl = existsSync(bundled) ? bundled : sourceFallback;
  const parsed: unknown = JSON.parse(readFileSync(metaUrl, "utf8"));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { pluginId?: unknown }).pluginId !== "string" ||
    typeof (parsed as { pluginVersion?: unknown }).pluginVersion !== "string"
  ) {
    throw new Error("server artifact metadata has no plugin identity");
  }
  return parsed as SentryPluginArtifactIdentity;
}
