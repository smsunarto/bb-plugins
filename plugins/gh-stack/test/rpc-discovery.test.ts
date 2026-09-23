import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

test("publishes every RPC method with a description for bb plugin rpc inspect", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "gh-stack" });
  await plugin(bb);
  const published = harness.inspection.registrations.experimental_publishedRpcMethods;
  assert.deepEqual(published.map((entry) => entry.method).sort(), [
    "addBranch",
    "checkoutBranch",
    "createStack",
    "getStack",
    "magicStack",
    "mergeStack",
    "runAction",
    "saveSettings",
    "setPrDraft",
    "suggestStackName",
  ]);
  for (const entry of published) {
    assert.equal(typeof entry.methodDescription, "string", entry.method);
    assert.equal(entry.inputSchema.type, "object", entry.method);
    assert.equal(entry.outputSchema.type, "object", entry.method);
  }
  await harness.lifecycle.dispose();
});
