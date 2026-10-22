import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

test("status reports incomplete setup without attempting a cloud call", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "gcp-machine" });
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  const result = await harness.behavior.runCli(["status"]);
  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.stdout).configured, false);
  assert.equal(harness.inspection.experimental_hostRpcCalls.length, 0);
});
