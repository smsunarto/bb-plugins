import assert from "node:assert/strict";
import { test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { experimental_scanPublicSdkOnly as scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("the plugin imports only the public SDK and its declared dependencies", () => {
  const report = scanPublicSdkOnly(PLUGIN_ROOT, {
    allow: [
      /^@ampcode\/sdk$/,
      /^bun:test$/,
      /^zod$/,
      /^react$/,
      // The scanner extends its allowlist for `*.test.*` files only; the
      // manual parity recorder (test/helpers/record-parity.ts) legitimately
      // imports the same public testing kit the parity test uses.
      /^@get-bb\/plugin-sdk\/provider-bridge\/testing$/,
      // declaration.test.ts gates the provider declaration through the SDK's
      // own validator, which the SDK exports only under internal/. Shipped
      // code imports nothing internal; this covers that one test import.
      /^@get-bb\/plugin-sdk\/internal\/host-policy$/,
    ],
  });
  assert.ok(report.files.length > 0, "the scan found no source files");
  assert.deepEqual(
    report.violations,
    [],
    report.violations
      .map((violation) => `${violation.file}: ${violation.specifier} (${violation.reason})`)
      .join("\n"),
  );
  assert.deepEqual(report.privateDependencies, []);
});
