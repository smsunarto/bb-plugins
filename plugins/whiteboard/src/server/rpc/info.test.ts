import { definePlugin } from "@bb-kit/core/plugin";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, test } from "vitest";
import type { InfoInput } from "../../shared/contracts/api-tunnel.ts";
import type { Engine } from "../../shared/contracts/engine.ts";
import { info } from "./info.ts";

async function start() {
  const inputs: InfoInput[] = [];
  const engine = {
    info: async (input: InfoInput) => {
      inputs.push(input);
      return {
        appVersion: "0.1.0",
        softwareMapEnabled: true,
        scratchpadEnabled: false,
        structuralDiffEnabled: input.sessionId === "with-diffr",
      };
    },
  } as unknown as Engine;
  const plugin = definePlugin({
    pluginId: "whiteboard",
    rpc: { info },
    services: () => ({ engine }),
  });
  const { bb, harness } = createFakePluginHost({ pluginId: "whiteboard" });
  await plugin(bb);
  return { harness, inputs };
}

test("answers the engine's info for the panel's thread and session", async () => {
  const { harness, inputs } = await start();

  await expect(
    harness.behavior.callRpc("info", { threadId: "t1", sessionId: "with-diffr" }),
  ).resolves.toEqual({
    appVersion: "0.1.0",
    softwareMapEnabled: true,
    scratchpadEnabled: false,
    structuralDiffEnabled: true,
  });
  await expect(harness.behavior.callRpc("info", {})).resolves.toMatchObject({
    structuralDiffEnabled: false,
  });
  expect(inputs).toEqual([{ threadId: "t1", sessionId: "with-diffr" }, {}]);
});

test("rejects unknown input keys before reaching the engine", async () => {
  const { harness, inputs } = await start();

  await expect(harness.behavior.callRpc("info", { reviewId: "r1" })).rejects.toThrow(
    "rpc input validation failed",
  );
  expect(inputs).toEqual([]);
});
