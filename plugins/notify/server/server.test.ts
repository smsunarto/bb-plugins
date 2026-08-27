import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { PluginAgentConfigurationContext } from "@get-bb/plugin-sdk";
import plugin from "./server.ts";

function session(): PluginAgentConfigurationContext {
  return {
    thread: { id: "thread-test", title: null, parentThreadId: null, sourceThreadId: null },
    project: { id: "project-test", kind: "personal", name: "Test", gitRemoteUrl: null },
    environment: {
      id: "env-test",
      name: null,
      path: null,
      workspaceProvisionType: "personal",
      branchName: null,
    },
    host: { id: "host-test", name: "Test host" },
    provider: {
      id: "test-provider",
      model: "test-model",
      capabilities: { supportsNativeUserQuestion: false },
    },
    origin: { kind: null, pluginId: null },
  };
}

test("server.ts registers notify_user and gates it on the agentTool setting", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "notify" });
  await plugin(bb);

  assert.deepEqual(
    harness.registrations.agentTools.map((tool) => tool.name),
    ["notify_user"],
  );
  const registered = harness.registrations.agentTools[0]!;
  assert.equal(
    registered.description,
    "Post a desktop notification on the user's machine. Use it when the user has likely walked away and something needs them now: a long job finished, or you are blocked on a decision. Do not use it for routine progress while they are watching.",
  );
  assert.equal(
    registered.instructions,
    "notify_user posts a native desktop notification titled with the project and thread. Keep the message under 120 characters, lead with what the user would act on, and write plain prose — markdown syntax is stripped, not rendered.",
  );
  assert.deepEqual(registered.presentation, {
    label: { pending: "Notifying the user", completed: "Notified the user" },
  });

  // agentTool defaults false, so the synthesized configure selects nothing.
  const before = await harness.resolveAgentConfiguration(session());
  assert.deepEqual(before.tools, []);
  assert.deepEqual(before.skills, []);

  await harness.setSettings({ agentTool: true });
  const after = await harness.resolveAgentConfiguration(session());
  assert.deepEqual(
    after.tools.map((tool) => tool.name),
    ["notify_user"],
  );
  assert.deepEqual(after.skills, []);
});

test("notify_user delivers through the real host object and reports the held state", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "notify" });
  await plugin(bb);
  await harness.setSettings({ agentTool: true });

  // The fake host has no /pending long-poll, so delivery holds the
  // notification and the tool reports the no-window contract string.
  const result = await harness.callAgentTool("notify_user", { message: "Build finished" });
  assert.equal(result, "No BB window is open; the notification will appear when one is.");
});

test("invalid arguments are rejected by the host's parse step, not plugin code", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "notify" });
  await plugin(bb);

  await assert.rejects(
    harness.callAgentTool("notify_user", { message: "" }),
    /tool "notify_user" arguments are invalid/,
  );
  await assert.rejects(
    harness.callAgentTool("notify_user", {}),
    /tool "notify_user" arguments are invalid/,
  );
});
