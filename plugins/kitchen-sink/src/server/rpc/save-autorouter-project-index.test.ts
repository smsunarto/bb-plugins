import { expect, test } from "bun:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

test("index writes reject nonexistent projects and retain unregistered repositories", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "kitchen-sink" });
  await plugin(bb);
  harness.sdk.stub("projects.list", async () => []);
  const entry = {
    repository: "unregistered",
    path: "/git/unregistered",
    hostId: "host",
    projectId: null,
    summary: "An unregistered repository.",
    examples: ["First task", "Second task", "Third task"],
  };
  expect(await harness.callRpc("saveAutorouterProjectIndex", { entries: [entry] })).toEqual({
    count: 1,
  });
  await expect(
    harness.callRpc("saveAutorouterProjectIndex", {
      entries: [{ ...entry, projectId: "invented" }],
    }),
  ).rejects.toThrow("Unknown BB project");
  const reloaded = await harness.reload(plugin);
  expect(await reloaded.harness.callRpc("getAutorouterProjectIndex")).toEqual({ entries: [entry] });
  await reloaded.harness.dispose();
});
