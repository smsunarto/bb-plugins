import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { registerThreadMenuRpc } from "../lib/thread-menu-rpc.ts";

function setup(overrides: Parameters<typeof makeThreadResponse>[0] = {}) {
  const thread = makeThreadResponse({ id: "row", sectionId: null, pinnedAt: null, ...overrides });
  const mutations: unknown[] = [];
  const host = createFakePluginHost({
    pluginId: "gtd-sidebar",
    sdk: {
      threadSections: {
        list: async () => [{ id: "later", name: "Later", createdAt: 1, updatedAt: 1 }],
      },
      threads: {
        get: async ({ threadId }) => {
          assert.equal(threadId, "row");
          return thread;
        },
        update: async (input) => {
          mutations.push(["update", input]);
          return thread;
        },
        unpin: async (input) => {
          mutations.push(["unpin", input]);
          return thread;
        },
      },
    },
  });
  registerThreadMenuRpc(host.bb);
  return {
    host,
    mutations,
    call: (sectionId: string | null) =>
      host.harness.behavior.callRpc("moveThreadToSection", { threadId: "row", sectionId }),
  };
}

describe("native sidebar section actions", () => {
  it("lists the host's sections", async () => {
    const { host } = setup();
    assert.deepEqual(await host.harness.behavior.callRpc("listThreadMenuSections", {}), {
      sections: [{ id: "later", name: "Later" }],
    });
  });

  it("moves and unpins the requested row", async () => {
    const { call, mutations } = setup({ pinnedAt: 1 });
    assert.deepEqual(await call("later"), { ok: true });
    assert.deepEqual(mutations, [
      ["update", { threadId: "row", sectionId: "later" }],
      ["unpin", { threadId: "row" }],
    ]);
  });

  it("can move out of Pinned into its current section without rewriting it", async () => {
    const { call, mutations } = setup({ pinnedAt: 1, sectionId: "later" });
    await call("later");
    assert.deepEqual(mutations, [["unpin", { threadId: "row" }]]);
  });

  it("moves to the default Threads section", async () => {
    const { call, mutations } = setup({ sectionId: "later" });
    await call(null);
    assert.deepEqual(mutations, [["update", { threadId: "row", sectionId: null }]]);
  });

  it("rejects missing sections without changing the row", async () => {
    const { call, mutations } = setup({ pinnedAt: 1 });
    await assert.rejects(call("deleted"), /no longer exists/);
    assert.deepEqual(mutations, []);
  });

  for (const overrides of [{ parentThreadId: "parent" }, { archivedAt: 1 }]) {
    it(`rejects an ineligible row: ${JSON.stringify(overrides)}`, async () => {
      const { call, mutations } = setup(overrides);
      await assert.rejects(call("later"), /Only active root threads/);
      assert.deepEqual(mutations, []);
    });
  }
});
