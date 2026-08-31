// Static layer: the shipped modules import only the public SDK surface.
// server.ts's module graph must stay off every @get-bb/plugin-sdk subpath
// (the path-install runtime shim cannot resolve them), and only host/bridge/*
// may import @get-bb/plugin-sdk/provider-bridge; shared/provider-catalog.ts imports
// nothing. The scanner enforces the first fact; the graph shape is upheld by
// the imports themselves and reviewed here by allowlist absence.
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
      /^parallel-web$/,
      /^zod$/,
      /^@bb-kit\/core\/(?:command|plugin)$/,
      /^nanocodex\/(?:durability|host|node(?:\/transport)?|worker)$/,
      // The scanner extends its allowlist for `*.test.*` files only; the
      // tests assemble deltas through the SDK's public testing kits.
      /^@get-bb\/plugin-sdk\/provider-bridge\/testing$/,
      // declaration.test.ts gates the declaration through the SDK's own
      // validator, exported only under internal/. Shipped code imports
      // nothing internal; this entry covers that one test import.
      /^@get-bb\/plugin-sdk\/internal\/host-policy$/,
    ],
  });
  // The generated bundle contains upstream implementation text, not plugin
  // imports. The relocation test executes the final single-file host instead.
  const authoredViolations = report.violations.filter(
    (violation) => violation.file !== "host/generated/nanocodex-runtime.mjs",
  );
  assert.ok(report.files.length > 0, "the scan found no source files");
  assert.ok(
    report.files.includes("host/generated/nanocodex-runtime.mjs"),
    "the scan did not see the embedded runtime",
  );
  assert.deepEqual(
    authoredViolations,
    [],
    authoredViolations
      .map((violation) => `${violation.file}: ${violation.specifier} (${violation.reason})`)
      .join("\n"),
  );
  assert.deepEqual(report.privateDependencies, []);
});
