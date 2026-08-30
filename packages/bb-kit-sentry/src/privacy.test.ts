import assert from "node:assert/strict";
import { test } from "node:test";
import type { ErrorEvent } from "@sentry/node";
import { FIXED_EXCEPTION_MESSAGE, redactPluginError, sanitizeSentryEvent } from "./privacy.ts";

test("redactPluginError replaces the message and stack header", () => {
  const source = new Error("token=private");
  source.stack = "PrivateError: token=private\n    at callback (/Users/alice/plugin.ts:4:2)";
  const redacted = redactPluginError(source);
  assert.equal(redacted.name, "Error");
  assert.equal(redacted.message, FIXED_EXCEPTION_MESSAGE);
  assert.equal(
    redacted.stack,
    `Error: ${FIXED_EXCEPTION_MESSAGE}\n    at callback (/Users/alice/plugin.ts:4:2)`,
  );
  assert.doesNotMatch(redacted.stack, /token=private/u);
});

test("sanitizeSentryEvent returns only the privacy allowlist", () => {
  const event: ErrorEvent = {
    type: undefined,
    event_id: "event-id",
    timestamp: 42,
    start_timestamp: 41,
    level: "error",
    platform: "node",
    message: "token=private",
    logger: "private-logger",
    server_name: "private-host",
    release: "notify@1.2.3",
    dist: "private-dist",
    environment: "test",
    sdk: {
      name: "sentry.javascript.node",
      version: "10.72.0",
      integrations: ["PrivateIntegration"],
      packages: [{ name: "private-package", version: "1" }],
    },
    request: { url: "https://private.example/secret" },
    transaction: "private-transaction",
    modules: { private: "1.0.0" },
    fingerprint: ["private-fingerprint"],
    exception: {
      values: [
        {
          type: "PrivateError",
          value: "token=private",
          module: "private-module",
          stacktrace: {
            frames: [
              {
                filename: "file:///Users/alice/git/bb-plugins/plugins/notify/server.ts",
                abs_path: "/Users/alice/git/bb-plugins/plugins/notify/server.ts",
                function: "sendNotification",
                lineno: 12,
                colno: 4,
                in_app: true,
                context_line: "throw new Error(secret)",
                pre_context: ["const secret = token"],
                post_context: ["return secret"],
                vars: { secret: "token=private" },
              },
              {
                filename: "/Users/alice/git/bb-plugins/node_modules/pkg/index.js",
                lineno: 2,
              },
            ],
          },
        },
        { type: "SecondPrivateError", value: "second private value" },
      ],
    },
    breadcrumbs: [{ message: "token=private" }],
    contexts: { private: { secret: "token=private" } },
    tags: {
      "bb.plugin.id": "notify",
      "bb.kit.boundary": "rpc.execute",
      "bb.kit.operation": "send",
      private: "token=private",
    },
    extra: { private: "token=private" },
    user: { email: "private@example.com" },
  };

  const sanitized = sanitizeSentryEvent(event);
  assert.deepEqual(sanitized, {
    type: undefined,
    event_id: "event-id",
    timestamp: 42,
    platform: "node",
    level: "error",
    release: "notify@1.2.3",
    environment: "test",
    sdk: { name: "sentry.javascript.node", version: "10.72.0" },
    tags: {
      "bb.plugin.id": "notify",
      "bb.kit.boundary": "rpc.execute",
      "bb.kit.operation": "send",
    },
    exception: {
      values: [
        {
          type: "Error",
          value: FIXED_EXCEPTION_MESSAGE,
          stacktrace: {
            frames: [
              {
                filename: "plugins/notify/server.ts",
                function: "sendNotification",
                lineno: 12,
                colno: 4,
                in_app: true,
              },
              { filename: "node_modules/pkg/index.js", lineno: 2 },
            ],
          },
        },
      ],
    },
  });
  assert.doesNotMatch(JSON.stringify(sanitized), /private|secret|alice/iu);
});
