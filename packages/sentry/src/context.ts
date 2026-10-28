export interface SentryPluginArtifactIdentity {
  readonly pluginId: string;
  readonly pluginVersion: string;
}

export function sentryPluginRelease(identity: SentryPluginArtifactIdentity): string {
  return `bb-plugin-${identity.pluginId}@${identity.pluginVersion}`;
}

/**
 * Keep Sentry's default environments to the two deployment stages used by
 * bb-plugins. An explicit SENTRY_ENVIRONMENT still wins for tests and custom
 * deployments.
 */
export function sentryPluginEnvironment(env: NodeJS.ProcessEnv): string {
  const explicit = env.SENTRY_ENVIRONMENT?.trim();
  if (explicit !== undefined && explicit.length > 0) return explicit;
  return env.NODE_ENV === "development" ? "development" : "production";
}
