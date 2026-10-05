import { definePlugin } from "@bb-kit/core/plugin";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, test } from "vitest";
import type { PendingOpen } from "../../shared/contracts/api-tunnel.ts";
import type { Engine } from "../../shared/contracts/engine.ts";
import { claimOpen } from "./claim-open.ts";

/** An engine with `waiting` opens; `asked` lists the claims it got. */
async function start(waiting: Record<string, PendingOpen>, asked: unknown[][] = []) {
  const engine = {
    async claimOpen(threadId: string, after?: number) {
      asked.push([threadId, after]);
      return waiting[threadId] ?? null;
    },
  } as unknown as Engine;
  const { bb, harness } = createFakePluginHost({ pluginId: "whiteboard" });
  await definePlugin({ pluginId: "whiteboard", rpc: { claimOpen }, services: () => ({ engine }) })(
    bb,
  );
  return harness;
}

test("forwards the thread's claim and its after to the engine", async () => {
  const asked: unknown[][] = [];
  const harness = await start({ t1: { sessionId: "s1", title: "Plan", at: 7 } }, asked);

  await expect(harness.behavior.callRpc("claimOpen", { threadId: "t1" })).resolves.toEqual({
    open: { sessionId: "s1", title: "Plan", at: 7 },
  });
  await expect(
    harness.behavior.callRpc("claimOpen", { threadId: "t2", after: 7 }),
  ).resolves.toEqual({ open: null });
  expect(asked).toEqual([
    ["t1", undefined],
    ["t2", 7],
  ]);
  await harness.dispose();
});

test("rejects a call without a thread", async () => {
  const harness = await start({});

  await expect(harness.behavior.callRpc("claimOpen", {})).rejects.toThrow(
    "rpc input validation failed",
  );
  await harness.dispose();
});
