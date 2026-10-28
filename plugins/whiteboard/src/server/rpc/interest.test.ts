import { defineRpcContract } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, test } from "vitest";
import type { Engine } from "../../shared/contracts/engine.ts";
import { interest, interestContract } from "./interest.ts";

test("each heartbeat renews the engine's worktree interest once", async () => {
  let renewals = 0;
  const engine = {
    async renewInterest() {
      renewals += 1;
    },
  } as unknown as Engine;
  const { bb, harness } = createFakePluginHost({ pluginId: "whiteboard" });
  bb.rpc.register(defineRpcContract({ interest: interestContract }), {
    interest: () => interest({ bb, engine }),
  });

  await expect(harness.behavior.callRpc("interest")).resolves.toEqual({});
  await expect(harness.behavior.callRpc("interest")).resolves.toEqual({});

  expect(renewals).toBe(2);
  await harness.dispose();
});
