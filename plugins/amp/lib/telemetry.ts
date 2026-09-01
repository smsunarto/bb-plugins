export { sentryPluginRelease as ampSentryRelease } from "@bb-kit/sentry/performance";

export const AMP_SENTRY_ENV = ["SENTRY_DSN", "SENTRY_ENVIRONMENT", "NODE_ENV"] as const;
