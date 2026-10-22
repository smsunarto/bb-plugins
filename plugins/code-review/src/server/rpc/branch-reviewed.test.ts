import { expect, test } from "bun:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

const range = { id: "a1b2c3d4e5f6", base: "a".repeat(40), head: "b".repeat(40) };

test("review marks persist, serialize concurrent files, and isolate both revision ends", async () => {
  const host = createFakePluginHost({ pluginId: "code-review" });
  const { bb } = host;
  let { harness } = host;
  await plugin(bb);
  const read = (revision = range) => harness.behavior.callRpc("branchReviewed", revision);
  const mark = (path: string, viewed: boolean) =>
    harness.behavior.callRpc("setBranchViewed", { ...range, path, viewed });
  expect(await read()).toEqual({ paths: [] });
  await Promise.all([mark("a.ts", true), mark("b.ts", true)]);
  expect(await read()).toEqual({ paths: ["a.ts", "b.ts"] });
  ({ harness } = await harness.lifecycle.reload(plugin));
  expect(await read()).toEqual({ paths: ["a.ts", "b.ts"] });
  expect(await read({ ...range, head: "c".repeat(40) })).toEqual({ paths: [] });
  expect(await read({ ...range, base: "c".repeat(40) })).toEqual({ paths: [] });
  expect(await read({ ...range, id: "ffffffffffff" })).toEqual({ paths: [] });
  await mark("a.ts", false);
  expect(await read()).toEqual({ paths: ["b.ts"] });
  expect(harness.inspection.realtimeSignals.at(-1)).toEqual({
    channel: "branch-review",
    payload: range,
  });
  await mark("b.ts", false);
  expect(await read()).toEqual({ paths: [] });
  for (let i = 1; i <= 6; i++) {
    await harness.behavior.callRpc("setBranchViewed", {
      ...range,
      head: i.toString(16).repeat(40),
      path: "a.ts",
      viewed: true,
    });
  }
  expect(await read({ ...range, head: "1".repeat(40) })).toEqual({ paths: [] });
  expect(await read({ ...range, head: "6".repeat(40) })).toEqual({ paths: ["a.ts"] });
  await expect(
    harness.behavior.callRpc("setBranchViewed", {
      ...range,
      head: "main",
      path: "a",
      viewed: true,
    }),
  ).rejects.toThrow();
  await harness.lifecycle.dispose();
});
