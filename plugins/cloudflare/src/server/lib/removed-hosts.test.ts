import { expect, test } from "bun:test";
import { createFakePluginHost, makeHostResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

const shares = {
  kept: { id: "0b8f3c2d-5e6a-4f7b-8c9d-1e2f3a4b5c6d", hostId: "mac" },
  deleted: { id: "7c2a8e1e-0d0f-4c8e-9a6b-6a4a0b6f2b11", hostId: "sandbox" },
  missed: { id: "3d1e7f4a-2b6c-4d8e-9f0a-5b7c9d1e3f2a", hostId: "gone" },
  unknown: { id: "9a4b6c8d-1e3f-4a5b-8c7d-2e4f6a8b0c1d", hostId: "flaky" },
};
const notFound = Object.assign(new Error("Host not found"), { status: 404 });

test("removed machines lose their quick shares, from the event and from the startup sweep", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "cloudflare",
    sdk: {
      hosts: {
        list: async () => [makeHostResponse({ id: "mac", status: "connected" })],
        get: async ({ hostId }: { hostId: string }) => {
          if (hostId === "flaky") throw new Error("bb unavailable");
          if (hostId === "gone") throw notFound;
          return makeHostResponse({ id: hostId, status: "disconnected" });
        },
      },
    },
  });
  const kv = bb.storage.kv;
  const now = new Date().toISOString();
  for (const share of Object.values(shares))
    await kv.set(`quick:${share.id}`, {
      ...share,
      port: 3000,
      label: "localhost:3000",
      createdAt: now,
      updatedAt: now,
    });
  const remaining = async () => (await kv.list("quick:")).toSorted();

  await plugin(bb);
  // The sweep runs in the background after setup. Only a 404 counts as removed.
  for (let i = 0; i < 50 && (await remaining()).length === 4; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(await remaining()).toEqual(
    [shares.kept, shares.deleted, shares.unknown].map((share) => `quick:${share.id}`).toSorted(),
  );

  const host = makeHostResponse({ id: "sandbox", status: "disconnected" });
  for (let i = 0; i < 2; i++) {
    const { errors } = await harness.behavior.emitThreadEvent("experimental_host.deleted", {
      host,
    });
    expect(errors).toEqual([]);
  }
  expect(await remaining()).toEqual(
    [shares.kept, shares.unknown].map((share) => `quick:${share.id}`).toSorted(),
  );
  expect(harness.inspection.experimental_hostRpcCalls).toEqual([]);
  await harness.lifecycle.dispose();
});
