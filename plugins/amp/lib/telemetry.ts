export const AMP_SENTRY_ENV = ["SENTRY_DSN", "SENTRY_ENVIRONMENT"] as const;

export interface AmpHostArtifactIdentity {
  readonly pluginId: string;
  readonly pluginVersion: string;
}

export function ampSentryRelease(identity: AmpHostArtifactIdentity): string {
  return `bb-plugin-${identity.pluginId}@${identity.pluginVersion}`;
}
