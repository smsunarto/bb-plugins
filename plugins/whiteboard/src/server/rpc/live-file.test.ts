import { definePlugin } from "@bb-kit/core/plugin";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, test } from "vitest";
import type { Engine } from "../../shared/contracts/engine.ts";
import { liveFile } from "./live-file.ts";

test("historical source stays readonly and invalid RPC inputs never reach the file reader", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "whiteboard" });
  let reads = 0;
  const engine = {
    request: async () => {
      reads++;
      return { status: 404, body: '{"error":"Review not found."}' };
    },
  } as unknown as Engine;
  await definePlugin({ pluginId: "whiteboard", rpc: { liveFile }, services: () => ({ engine }) })(
    bb,
  );
  try {
    expect(
      await harness.behavior.callRpc("liveFile", {
        sessionId: "missing",
        path: "a.ts",
        repositoryId: "repo",
        head: "abc",
      }),
    ).toEqual({ target: null });
    expect(reads).toBe(0);
    expect(
      await harness.behavior.callRpc("liveFile", {
        sessionId: "missing",
        path: "a.ts",
        version: 0,
      }),
    ).toEqual({ target: null });
    expect(reads).toBe(0);
    expect(
      await harness.behavior.callRpc("liveFile", { sessionId: "missing", path: "a.ts" }),
    ).toEqual({ target: null });
    expect(reads).toBe(1);
    await expect(
      harness.behavior.callRpc("liveFile", { sessionId: "missing", path: "" }),
    ).rejects.toThrow("rpc input validation failed");
    expect(reads).toBe(1);
  } finally {
    await harness.dispose();
  }
});
