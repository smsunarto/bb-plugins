import { test } from "bun:test";
import assert from "node:assert/strict";
import { createFakeContext } from "../fake-context.ts";
import { hosts } from "./hosts.ts";

test("lists the machines and the one the panel acts on", async () => {
  const ctx = createFakeContext({
    hosts: async () => ({
      selectedHostId: "host_mac",
      hosts: [
        { id: "host_server", name: "linux-builder", connected: true },
        { id: "host_mac", name: "Local Mac", connected: false },
      ],
    }),
  });

  assert.deepEqual(await hosts.execute(ctx), {
    selectedHostId: "host_mac",
    hosts: [
      { id: "host_server", name: "linux-builder", connected: true },
      { id: "host_mac", name: "Local Mac", connected: false },
    ],
  });
});
