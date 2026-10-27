import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import plugin from "../server";

it("loads the fork with no rules and saves a disabled rule without dispatching it", async () => {
  let { bb, harness } = createFakePluginHost({ pluginId: "slopcop" });
  try {
    await plugin(bb);
    expect(await harness.behavior.callRpc("listRules", null)).toEqual({ rules: [] });
    await harness.behavior.callRpc("saveRule", {
      id: null,
      rule: { name: "Fork smoke check", repo: "example/example", enabled: false },
    });
    const edited = await harness.behavior.runCli([
      "rules",
      "edit",
      "Fork smoke check",
      "--paths",
      "src/**",
      "--trigger",
      "new_issue",
    ]);
    expect(edited, edited.stderr).toMatchObject({ exitCode: 0 });
    ({ harness } = await harness.lifecycle.reload(plugin));
    expect(await harness.behavior.callRpc("listRules", null)).toMatchObject({
      rules: [
        {
          name: "Fork smoke check",
          enabled: false,
          mode: "shadow",
          triggers: ["new_issue"],
          conditions: [{ kind: "paths", globs: ["src/**"] }],
        },
      ],
    });
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("documents compound command usage and rejects unrelated options", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "slopcop" });
  try {
    await plugin(bb);
    const help = await harness.behavior.runCli(["rules", "--help"]);
    expect(help.stdout).toContain("rules enable|disable|rm <rule>");
    const invalid = await harness.behavior.runCli(["status", "--force"]);
    expect(invalid.exitCode).not.toBe(0);
    const missing = await harness.behavior.runCli(["check", "some-rule"]);
    expect(missing.exitCode).not.toBe(0);
  } finally {
    await harness.lifecycle.dispose();
  }
});
