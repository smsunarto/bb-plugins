import { expect, test } from "bun:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../src/server/server.ts";

test("the retired manager exports durable claims without registering Unity controls", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "kitchen-sink" });
  const db = bb.storage.database();
  db.exec("CREATE TABLE kitchen_sink_unity_editor_claims (record TEXT NOT NULL)");
  db.prepare("INSERT INTO kitchen_sink_unity_editor_claims VALUES (?)").run(
    '{"claimId":"kept","jobId":"native-job"}',
  );
  await plugin(bb);
  expect(await harness.callRpc("exportUnityClaims", {})).toEqual({
    version: 1,
    claims: ['{"claimId":"kept","jobId":"native-job"}'],
  });
  expect(harness.registrations.agentTools.map((tool) => tool.name)).not.toContain(
    "kitchen_sink_editors",
  );
  expect(harness.registrations.rpcMethods).toEqual([
    "renderEmbed",
    "exportUnityClaims",
    "getRpivTodos",
  ]);
  db.close();
});

test("a Kitchen Sink installation without old claims exports an empty handoff", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "kitchen-sink" });
  await plugin(bb);
  expect(await harness.callRpc("exportUnityClaims", {})).toEqual({ version: 1, claims: [] });
  bb.storage.database().close();
});
