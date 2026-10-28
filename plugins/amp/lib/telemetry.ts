export { sentryPluginRelease as ampSentryRelease } from "@bb-plugins/sentry/performance";

export const AMP_SENTRY_ENV = ["SENTRY_DSN", "SENTRY_ENVIRONMENT", "NODE_ENV"] as const;
