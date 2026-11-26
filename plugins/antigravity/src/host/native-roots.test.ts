import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import hostEntry from "./host.ts";
import { resolveAntigravityNativeRoots } from "./native-roots.ts";

test("resolveAntigravityNativeRoots discovers user/project plugins and skills.json roots", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bb-agy-roots-"));
  const homeDir = path.join(root, "home");
  const cwd = path.join(root, "workspace");

  try {
    // User plugin with skills/ directory
    const userPlugin = path.join(homeDir, ".gemini", "config", "plugins", "my-user-plugin");
    await mkdir(path.join(userPlugin, "skills"), { recursive: true });
    await writeFile(
      path.join(userPlugin, "plugin.json"),
      JSON.stringify({ name: "my-user-plugin" }),
    );

    // Project plugin with skills/ directory
    const projectPlugin = path.join(cwd, ".agents", "plugins", "team-tools");
    await mkdir(path.join(projectPlugin, "skills"), { recursive: true });
    await writeFile(
      path.join(projectPlugin, "plugin.json"),
      JSON.stringify({ name: "team-tools" }),
    );

    // Declared extra skill dir in workspace .agents/skills.json
    const extraSkills = path.join(cwd, "custom-skills");
    await mkdir(extraSkills, { recursive: true });
    await writeFile(
      path.join(cwd, ".agents", "skills.json"),
      JSON.stringify({ paths: ["../custom-skills"] }),
    );

    const warnings: string[] = [];
    const resolved = await resolveAntigravityNativeRoots({
      cwd,
      homeDir,
      warn: (message) => warnings.push(message),
    });

    assert.deepEqual(warnings, []);
    const skillPaths = new Set(resolved.skills.map((entry) => entry.path));
    assert.ok(skillPaths.has(path.join(projectPlugin, "skills")));
    assert.ok(skillPaths.has(path.join(userPlugin, "skills")));
    assert.ok(skillPaths.has(extraSkills));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("host entry exposes resolveNativeRoots through the SDK host harness", async () => {
  const harness = experimental_createHostEntryHarness(hostEntry);
  try {
    const result = await harness.experimental_call("resolveNativeRoots", {
      providerId: "antigravity",
      cwd: null,
    });
    assert.ok(Array.isArray(result.skills));
    assert.ok(Array.isArray(result.commands));
  } finally {
    await harness.experimental_dispose();
  }
});
