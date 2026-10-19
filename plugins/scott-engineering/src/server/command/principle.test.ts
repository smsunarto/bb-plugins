import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { definePlugin } from "@bb-kit/core/plugin";
import { principle } from "./principle.ts";

test("shared principles can be listed and read without an Architect workflow", async () => {
  const f = createFakePluginHost({ pluginId: "scott-engineering" });
  try {
    await definePlugin({ pluginId: "scott-engineering", rpc: {}, command: { principle } })(f.bb);
    const listed = await f.harness.behavior.runCli(["principle"]);
    assert.equal(listed.exitCode, 0);
    const names = listed.stdout?.trim().split("\n") ?? [];
    assert.equal(names.length, 22);
    assert.ok(names.includes("grug-brain"));
    for (const name of names) {
      const result = await f.harness.behavior.runCli(["principle", "--name", name]);
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout ?? "", /^# /);
    }
    const grug = await f.harness.behavior.runCli(["principle", "--name", "grug-brain"]);
    assert.match(grug.stdout ?? "", /Consolidate duplicated knowledge/);
  } finally {
    await f.harness.lifecycle.dispose();
  }
});

test("the principle reader rejects unknown names and paths", async () => {
  const f = createFakePluginHost({ pluginId: "scott-engineering" });
  try {
    await definePlugin({ pluginId: "scott-engineering", rpc: {}, command: { principle } })(f.bb);
    for (const name of ["unknown", "../subthreads", "../../package.json", "/etc/passwd"]) {
      const result = await f.harness.behavior.runCli(["principle", "--name", name]);
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr ?? "", /Unknown engineering principle/);
      assert.ok(!result.stdout);
    }
  } finally {
    await f.harness.lifecycle.dispose();
  }
});
