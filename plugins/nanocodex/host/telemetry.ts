import { existsSync, readFileSync } from "node:fs";
import { sentryErrorReporter, type SentryPluginReporter } from "@bb-kit/sentry/node";
import { sentryPluginEnvironment, sentryPluginRelease } from "@bb-kit/sentry/context";

interface NanocodexHostMeta {
  readonly pluginId: string;
  readonly pluginVersion: string;
}

export function createNanocodexErrorReporter(
  pluginId: string,
  env: NodeJS.ProcessEnv = process.env,
  metaUrl?: URL,
): SentryPluginReporter | undefined {
  const dsn = env.SENTRY_DSN?.trim();
  if (dsn === undefined || dsn.length === 0) return undefined;
  try {
    const identity = readHostMeta(metaUrl ?? resolveHostMetaUrl());
    if (identity.pluginId !== pluginId) return undefined;
    return sentryErrorReporter({
      dsn,
      release: sentryPluginRelease(identity),
      environment: sentryPluginEnvironment(env),
    })({ pluginId });
  } catch {
    return undefined;
  }
}

function resolveHostMetaUrl(): URL {
  const bundled = new URL("./host.meta.json", import.meta.url);
  if (existsSync(bundled)) return bundled;
  const sourceFallback = new URL("../dist/host.meta.json", import.meta.url);
  if (existsSync(sourceFallback)) return sourceFallback;
  throw new Error("NanoCodex host metadata is missing beside the host bundle and in dist");
}

function readHostMeta(metaUrl: URL): NanocodexHostMeta {
  const parsed: unknown = JSON.parse(readFileSync(metaUrl, "utf8"));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { pluginId?: unknown }).pluginId !== "string" ||
    typeof (parsed as { pluginVersion?: unknown }).pluginVersion !== "string"
  ) {
    throw new Error("NanoCodex host metadata has no plugin identity");
  }
  return parsed as NanocodexHostMeta;
}
