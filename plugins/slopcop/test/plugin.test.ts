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

it("adds, persists, replaces and clears excluded PR authors without dropping other filters", async () => {
  let { bb, harness } = createFakePluginHost({ pluginId: "slopcop" });
  try {
    await plugin(bb);
    const { rule } = await harness.behavior.callRpc("saveRule", {
      id: null,
      rule: {
        name: "Exclusions",
        repo: "example/example",
        enabled: false,
        conditions: [{ kind: "has_label", labels: ["security"] }],
      },
    });
    const edit = async (...options: string[]) => {
      const result = await harness.behavior.runCli(["rules", "edit", rule.id, ...options]);
      expect(result, result.stderr).toMatchObject({ exitCode: 0 });
    };
    await edit("--exclude-author", "@Dana,DANA,dependabot[bot]");
    ({ harness } = await harness.lifecycle.reload(plugin));
    expect(await harness.behavior.callRpc("listRules", null)).toMatchObject({
      rules: [
        {
          conditions: [
            { kind: "has_label", labels: ["security"] },
            { kind: "exclude_author", logins: ["dana", "dependabot[bot]"] },
          ],
        },
      ],
    });
    await edit("--prompt", "Keep the exclusions.");
    expect(await harness.behavior.callRpc("listRules", null)).toMatchObject({
      rules: [
        {
          conditions: expect.arrayContaining([
            { kind: "exclude_author", logins: ["dana", "dependabot[bot]"] },
          ]),
        },
      ],
    });
    await edit("--exclude-author", "@Other");
    expect(await harness.behavior.callRpc("listRules", null)).toMatchObject({
      rules: [
        {
          conditions: [
            { kind: "has_label", labels: ["security"] },
            { kind: "exclude_author", logins: ["other"] },
          ],
        },
      ],
    });
    await edit("--exclude-author", "");
    expect(await harness.behavior.callRpc("listRules", null)).toMatchObject({
      rules: [
        {
          conditions: [{ kind: "has_label", labels: ["security"] }],
        },
      ],
    });
  } finally {
    await harness.lifecycle.dispose();
  }
});
