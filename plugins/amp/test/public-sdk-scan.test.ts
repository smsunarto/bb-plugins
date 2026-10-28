import assert from "node:assert/strict";
import { test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { experimental_scanPublicSdkOnly as scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("the plugin imports only the public SDK and its declared dependencies", () => {
  const report = scanPublicSdkOnly(PLUGIN_ROOT, {
    allow: [
      /^bun:test$/,
      /^zod$/,
      /^react$/,
      // Public in SDK 0.6.94; its scanner's built-in list predates this export.
      /^@get-bb\/plugin-sdk\/process$/,
      // Browser, server, and host telemetry use public @bb-plugins/sentry entrypoints.
      // The host paths stay lazy without a DSN.
      /^@bb-plugins\/sentry\/(?:app|node|performance|telemetry)$/,
      // The scanner extends its allowlist for `*.test.*` files only; the
      // manual parity recorder (test/helpers/record-parity.ts) legitimately
      // imports the same public testing kit the parity test uses.
      /^@get-bb\/plugin-sdk\/provider-bridge\/testing$/,
      // declaration.test.ts gates the provider declaration through the SDK's
      // own validator, which the SDK exports only under internal/. Shipped
      // code imports nothing internal; this covers that one test import.
      /^@get-bb\/plugin-sdk\/internal\/host-policy$/,
      // The frontend test harness. The scanner's `*.test.*` extension already
      // covers the slot tests themselves; this entry covers
      // test/helpers/plugin-app-runtime.ts, which must install the runtime
      // from its own module scope so it evaluates before app.tsx does.
      /^@get-bb\/plugin-sdk\/testing\/app$/,
      // act/cleanup for those slot tests. Declaring a dependency does not
      // exempt it from this scan, the same way `zod` is declared and still
      // listed above, so the entry stays alongside the devDependency.
      /^@testing-library\/react$/,
    ],
  });
  assert.ok(report.files.length > 0, "the scan found no source files");
  // Storybook stories are repository tooling, never bundled into the plugin:
  // they import Storybook and the shared ../../../.storybook harness.
  const violations = report.violations.filter(
    (violation) => !violation.file.startsWith("storybook/"),
  );
  assert.deepEqual(
    violations,
    [],
    violations
      .map((violation) => `${violation.file}: ${violation.specifier} (${violation.reason})`)
      .join("\n"),
  );
  assert.deepEqual(report.privateDependencies, []);
});
