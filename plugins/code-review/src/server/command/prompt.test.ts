import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { PLUGIN_CLI_OUTPUT_MAX_BYTES } from "@get-bb/plugin-sdk";
import plugin from "../server.ts";

test("prompt adds the shared guidance and preserves the request without starting threads", async () => {
  const f = createFakePluginHost({ pluginId: "code-review" });
  await plugin(f.bb);
  try {
    const request =
      "Intent: handle reconnects\nTarget: abc123..def456\nFocus: `reconnect()` and $(literal).";
    const result = await f.harness.behavior.runCli(["prompt", "--request", request]);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /^You are an adversarial reviewer\./);
    assert.match(result.stdout, /bb review playbook --name <listed-name>/);
    assert.match(result.stdout, /Do not edit files, commit, or start other threads\./);
    assert.ok(result.stdout.endsWith(`## Review request\n\n${request}\n`));
    assert.equal(f.harness.inspection.sdk.calls.length, 0);
  } finally {
    await f.harness.lifecycle.dispose();
  }
});

test("prompt rejects missing, blank, and oversized requests without emitting a partial prompt", async () => {
  const f = createFakePluginHost({ pluginId: "code-review" });
  await plugin(f.bb);
  try {
    for (const args of [
      [],
      ["--request", " \n "],
      ["--request", "界".repeat(PLUGIN_CLI_OUTPUT_MAX_BYTES / 3)],
    ]) {
      const result = await f.harness.behavior.runCli(["prompt", ...args]);
      assert.equal(result.exitCode, 1);
      assert.equal(result.stdout, "");
      assert.ok(result.stderr);
    }
  } finally {
    await f.harness.lifecycle.dispose();
  }
});
