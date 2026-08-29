/**
 * `test/conformance.test.ts` — the published suite against the real bridge.
 *
 * All three optional fixtures are supplied. They are opt-in GATES, not extras:
 * omitting `zeroWorkPromptInput` silently SKIPS `turn/settles-without-activity`,
 * omitting `interruptiblePromptInput` skips `session/threads-independent` AND
 * `stop/interrupt-settles-before-result`, and omitting `icons` skips
 * `presentation/icon-namespaced-declared`. A green report with three skips is
 * the failure mode this file exists to prevent, so the assertion checks status
 * per result rather than only `report.passed`.
 *
 * Two scenarios run only because of the continuity design:
 *   `session/resume-identity`    runs only when `sessionRestore` is declared.
 *   `session/fork-identity`      runs only when `fork` is not "none".
 * Both would be skipped by an honest single-turn bridge.
 */

import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  experimental_captureBridgeJsonRpcOutput as captureBridgeJsonRpcOutput,
  experimental_formatConformanceReport as formatConformanceReport,
  experimental_runBridgeConformance as runBridgeConformance,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import {
  NANOCODEX_ARGS_OVERRIDE_ENV,
  NANOCODEX_COMMAND_OVERRIDE_ENV,
} from "../src/catalog.ts";
import { experimental_providerBridge, handleLine } from "../src/bridge/entry.ts";
import { installFakeNanocodex } from "./fake-nanocodex.ts";

test("the nanocodex bridge passes the SDK conformance suite", async () => {
  const root = mkdtempSync(join(tmpdir(), "nanocodex-conformance-"));
  const workspace = join(root, "workspace");
  const dataDir = join(root, "data");
  const tempDir = join(root, "temp");
  for (const dir of [workspace, dataDir, tempDir]) mkdirSync(dir, { recursive: true });
  const fake = installFakeNanocodex(root);

  const previousCommand = process.env[NANOCODEX_COMMAND_OVERRIDE_ENV];
  const previousArgs = process.env[NANOCODEX_ARGS_OVERRIDE_ENV];
  process.env[NANOCODEX_COMMAND_OVERRIDE_ENV] = fake.command;
  process.env[NANOCODEX_ARGS_OVERRIDE_ENV] = JSON.stringify(fake.args);
  const output = captureBridgeJsonRpcOutput();
  try {
    experimental_providerBridge.start?.({ pluginId: "nanocodex", dataDir, tempDir });
    const report = await runBridgeConformance({
      providerId: "nanocodex",
      transport: { send: handleLine, takeMessages: output.takeMessages },
      session: {
        cwd: workspace,
        // TOOLS makes the fake CLI replay the code-mode tool sequence, so the
        // turn carries items with presentations and the icon rule can inspect
        // them instead of skipping (a skip fails this suite).
        promptInput: [{ type: "text", text: "TOOLS", mentions: [] }],
        zeroWorkPromptInput: [{ type: "text", text: "NOOP", mentions: [] }],
        interruptiblePromptInput: [{ type: "text", text: "HOLD_OPEN", mentions: [] }],
        icons: { pluginId: "nanocodex", names: ["terminal"] },
      },
      timeoutMs: 20_000,
    });
    for (const result of report.results) {
      assert.equal(result.status, "pass", `${result.id}: ${result.detail}`);
    }
    assert.equal(report.passed, true, formatConformanceReport(report));
  } finally {
    output.restore();
    if (previousCommand === undefined) delete process.env[NANOCODEX_COMMAND_OVERRIDE_ENV];
    else process.env[NANOCODEX_COMMAND_OVERRIDE_ENV] = previousCommand;
    if (previousArgs === undefined) delete process.env[NANOCODEX_ARGS_OVERRIDE_ENV];
    else process.env[NANOCODEX_ARGS_OVERRIDE_ENV] = previousArgs;
    rmSync(root, { recursive: true, force: true });
  }
});
