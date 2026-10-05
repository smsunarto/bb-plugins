import { definePlugin } from "@bb-kit/core/plugin";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, test } from "vitest";
import type { Engine } from "../../shared/contracts/engine.ts";
import { interest } from "./interest.ts";

test("each heartbeat renews the engine's worktree interest once", async () => {
  let renewals = 0;
  const engine = {
    async renewInterest() {
      renewals += 1;
    },
  } as unknown as Engine;
  const { bb, harness } = createFakePluginHost({ pluginId: "whiteboard" });
  await definePlugin({ pluginId: "whiteboard", rpc: { interest }, services: () => ({ engine }) })(
    bb,
  );

  await expect(harness.behavior.callRpc("interest")).resolves.toEqual({});
  await expect(harness.behavior.callRpc("interest")).resolves.toEqual({});

  expect(renewals).toBe(2);
  await harness.dispose();
});
