# @bb-kit/sentry

`@bb-kit/sentry` adds opt-in, Node-only Sentry reporting to `@bb-kit/core` plugins.
It creates an isolated client for each plugin factory execution. A missing or blank DSN disables
reporting.

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

## License

MIT
