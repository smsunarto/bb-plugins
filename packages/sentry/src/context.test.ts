import assert from "node:assert/strict";
import { test } from "node:test";
import { sentryPluginEnvironment, sentryPluginRelease } from "./context.ts";

test("plugin releases use the Sentry release tag convention", () => {
  assert.equal(
    sentryPluginRelease({ pluginId: "amp", pluginVersion: "1.2.3" }),
    "bb-plugin-amp@1.2.3",
  );
});

test("plugin environments distinguish development from production", () => {
  assert.equal(sentryPluginEnvironment({ NODE_ENV: "development" }), "development");
  assert.equal(sentryPluginEnvironment({ NODE_ENV: "production" }), "production");
  assert.equal(sentryPluginEnvironment({}), "production");
  assert.equal(
    sentryPluginEnvironment({ NODE_ENV: "production", SENTRY_ENVIRONMENT: "test" }),
    "test",
  );
});
