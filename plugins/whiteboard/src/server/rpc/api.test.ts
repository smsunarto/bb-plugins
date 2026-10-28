import { defineRpcContract } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, test } from "vitest";
import type { Engine } from "../../shared/contracts/engine.ts";
import { api, apiContract } from "./api.ts";

test("the tunnel validates requests and preserves the engine's binary response envelope", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "whiteboard" });
  const calls: unknown[] = [];
  const response = { status: 200, contentType: "image/png", encoding: "base64", body: "AAEC" };
  const engine = {
    request: async (input: unknown) => {
      calls.push(input);
      return response;
    },
  } as Engine;
  bb.rpc.register(defineRpcContract({ api: apiContract }), {
    api: (input) => api({ bb, engine }, input),
  });
  try {
    const input = { method: "GET", path: "/session/resources/image", threadId: "t1" };
    expect(await harness.behavior.callRpc("api", input)).toEqual(response);
    expect(calls).toEqual([input]);
    await expect(
      harness.behavior.callRpc("api", { method: "DELETE", path: "/session" }),
    ).rejects.toThrow("rpc input validation failed");
    expect(calls).toHaveLength(1);
  } finally {
    await harness.dispose();
  }
});
