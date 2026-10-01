import { expect, test } from "bun:test";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";

async function instructionsFor(origin: { kind: "fork" | null; pluginId: string | null }) {
  const host = createFakePluginHost({ pluginId: "review" });
  await plugin(host.bb);
  const resolved = await host.harness.resolveAgentConfiguration(
    makePluginAgentConfigurationContext({ origin }),
  );
  return resolved.instructions;
}

test("an ordinary thread is told to request a review before ending a turn", async () => {
  expect(await instructionsFor({ kind: null, pluginId: null })).toContain(
    "Run `bb review start --file <path>`",
  );
});

test("reviewers and side chats are not told to request a review", async () => {
  expect(await instructionsFor({ kind: null, pluginId: "review" })).toBeNull();
  expect(await instructionsFor({ kind: "fork", pluginId: "side-chat" })).toBeNull();
});
