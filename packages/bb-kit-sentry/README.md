# @bb-kit/sentry

`@bb-kit/sentry` adds privacy-filtered Sentry reporting to bb plugin servers and browser apps.
Reporting is on by default when a DSN is available. The server reporter adds a `telemetry` boolean
to the plugin's bb settings so users can opt out. Each plugin gets an isolated client. A missing or
blank DSN disables reporting.

```ts
import { definePlugin } from "@bb-kit/core/plugin";
import { sentryErrorReporter } from "@bb-kit/sentry/node";

export default definePlugin({
  pluginId: "my-plugin",
  errorReporter: sentryErrorReporter({
    dsn: process.env.SENTRY_DSN,
    release: process.env.SENTRY_RELEASE,
    environment: process.env.SENTRY_ENVIRONMENT,
  }),
  rpc,
});
```

The adapter sends a fixed exception message, sanitized stack frames, and controlled `bb.*` tags.
It does not send callback input, raw error messages, user data, breadcrumbs, or request data.

## Browser apps

`@bb-kit/sentry/app` wraps a plugin app's registrations. It reports setup, render, registered
callback, content-script, and plugin-owned global errors. Errors still propagate to bb's existing
containment boundaries.

```tsx
import { sentryAppTelemetry } from "@bb-kit/sentry/app";
import { definePluginApp } from "@get-bb/plugin-sdk/app";

const telemetry = sentryAppTelemetry({
  pluginId: "my-plugin",
  pluginVersion: "1.0.0",
  dsn: "https://public-key@example.ingest.sentry.io/project-id",
});

export default definePluginApp(
  telemetry.instrument((app) => {
    app.slots.navPanel({/* registration */});
  }),
);
```

The browser client reads the same `telemetry` setting before every send. It limits each page to 25
events and only attributes global errors whose stack points at that plugin's app bundle.

Performance tracing is a separate, lightweight entry point. It records elapsed numeric checkpoints
and emits a Sentry envelope only after the measured work has finished, without loading the Sentry
SDK on the measured path:

```ts
import { sentryPerformanceReporter } from "@bb-kit/sentry/performance";

const performance = sentryPerformanceReporter({ dsn: process.env.SENTRY_DSN })({
  pluginId: "my-plugin",
});
const trace = performance?.start({ operation: "cli.startup", variant: "fresh" });
trace?.checkpoint("spawned");
trace?.checkpoint("protocol_ready");
trace?.finish("ok");
```

Operation, variant, and checkpoint names must be static developer-authored values. Transaction
sanitization removes application context, child spans, and uncontrolled tags.

## One-call plugin telemetry

`@bb-kit/sentry/telemetry` wires both reporters for a published plugin in a single call. It reads
the release from the `server.meta.json` sidecar the build writes next to the server bundle, so the
release always matches the uploaded source maps:

```ts
import { definePlugin } from "@bb-kit/core/plugin";
import { sentryPluginTelemetry } from "@bb-kit/sentry/telemetry";

const telemetry = sentryPluginTelemetry({
  pluginId: "my-plugin",
  serverEntryUrl: import.meta.url,
});

export default definePlugin({
  pluginId: "my-plugin",
  errorReporter: telemetry.errorReporter,
  performanceReporter: telemetry.performanceReporter,
  rpc,
});
```

Telemetry is enabled by default. The DSN comes from `SENTRY_DSN` in the environment where bb runs
the plugin, or from the `dsn` option baked into the plugin. Without either, telemetry stays
disabled. A missing, unreadable, or mismatched sidecar also disables telemetry, so a drifted
install never reports under a wrong release.

### Opting out

When `definePlugin` runs the reporter factories, it hands them the bb plugin API. The reporters
then define a `telemetry` boolean setting (default on) in the plugin's settings — plugin authors
never declare it. Turning it off stops every send, and the change applies live through
`settings.onChange`. Nothing is sent while the stored value is still loading, and a broken
settings store fails open to the default.

Environment overrides:

- `SENTRY_DSN` — overrides the baked `dsn` option. When neither is set, no telemetry.
- `SENTRY_ENVIRONMENT` — optional environment override. Otherwise `NODE_ENV=development` maps to
  `development`, and every other runtime maps to `production`.
- `SENTRY_TRACES_SAMPLE_RATE` — trace sampling in `[0, 1]`. Defaults to `0.1`.

## License

MIT
