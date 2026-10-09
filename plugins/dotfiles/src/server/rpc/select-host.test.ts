import { test } from "bun:test";
import assert from "node:assert/strict";
import { createFakeContext } from "../fake-context.ts";
import { selectHost } from "./select-host.ts";

test("stores the picked machine", async () => {
  const picked: string[] = [];
  const ctx = createFakeContext({
    selectHost: async (hostId) => {
      picked.push(hostId);
    },
  });

  assert.deepEqual(await selectHost.execute(ctx, { hostId: "host_mac" }), {
    selectedHostId: "host_mac",
  });
  assert.deepEqual(picked, ["host_mac"]);
});
