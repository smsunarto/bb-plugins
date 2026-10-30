import { defineRpcContract } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, test } from "vitest";
import type { Engine } from "../../shared/contracts/engine.ts";
import { ReviewInputError } from "../../shared/review/input-error.ts";
import { liveFile, liveFileContract } from "./live-file.ts";

test("historical source stays readonly and invalid RPC inputs never reach the file reader", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "whiteboard" });
  let reads = 0;
  const engine = {
    api: {
      file: async () => {
        reads++;
        throw new ReviewInputError("Whiteboard not found.", 404);
      },
    },
    run: (_context: unknown, fn: (signal: AbortSignal) => Promise<unknown>) =>
      fn(new AbortController().signal),
  } as unknown as Engine;
  bb.rpc.register(defineRpcContract({ liveFile: liveFileContract }), {
    liveFile: (input) => liveFile({ bb, engine }, input),
  });
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
