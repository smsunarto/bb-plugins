import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

test("wake explains that provider enrollment is required", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "gcp-machine" });
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  const result = await harness.behavior.runCli(["wake"]);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Enroll the configured VM/);
  assert.equal(harness.inspection.sdk.callsTo("hosts.experimental_resume").length, 0);
});
