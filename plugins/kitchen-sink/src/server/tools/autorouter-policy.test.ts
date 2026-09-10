import { expect, mock, test } from "bun:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin, { SMART_EMBED_INSTRUCTIONS } from "../server.ts";
import { readAutorouterSettings, autorouterAgentEnabled } from "../lib/autorouter/settings.ts";
import {
  DEFAULT_ENABLED_ROUTES,
  enabledRouteIds,
  MODELS,
  ROUTES,
} from "../../shared/autorouter/policy.ts";

test("default route selection is exact and disabling a model removes all its efforts", () => {
  expect([...enabledRouteIds({})].sort()).toEqual(
    [
      "astra/low",
      "astra/medium",
      "astra/high",
      "astra/xhigh",
      "astra/ultra",
      "luna/max",
      "fable/high",
      "fable/xhigh",
      "fable/ultracode",
      "opus/high",
      "opus/xhigh",
    ].sort(),
  );
  expect(
    [...enabledRouteIds({ autorouterModel_astra: false })].some((id) => id.startsWith("astra/")),
  ).toBe(false);
});

test("agent policy uses live settings, enabled routes, and confirmed usage", async () => {
  const usageLimits = mock(async () => ({
    "claude-code": {
      status: "ok" as const,
      accountEmail: null,
      planLabel: null,
      windows: [{ label: "Fable", usedPercent: 100, resetsAt: null }],
    },
  }));
  const { bb, harness } = createFakePluginHost({
    pluginId: "kitchen-sink",
    settings: { autorouterEnabled: true },
    sdk: {
      threads: {
        get: async () => ({
          providerId: "codex",
          parentThreadId: "parent",
          environmentId: null,
          projectId: "proj_personal",
        }),
        defaultExecutionOptions: async () => ({ model: "gpt-5.6-luna", reasoningLevel: "max" }),
      },
      providers: {
        models: async (args) => ({
          providers: [{ id: args?.providerId, displayName: args?.providerId, available: true }],
          models: MODELS.filter((model) => model.providerId === args?.providerId).map((model) => ({
            model: model.model,
            displayName: model.label,
            supportedReasoningEfforts: ROUTES.filter((route) => route.key === model.key).map(
              (route) => ({ reasoningEffort: route.reasoningLevel }),
            ),
          })),
        }),
      },
      system: { config: async () => ({ primaryHostId: "host" }), usageLimits },
    },
  });
  await plugin(bb);
  const instructions = harness.registrations.instructionProvider?.({
    threadId: "child",
    projectId: "project",
  });
  expect(instructions).toContain("kitchen_sink_autorouter_policy");
  expect(instructions!.length).toBeLessThan(4096);
  const initial = await readAutorouterSettings(bb);
  expect(initial.enabledRoutes).toEqual(DEFAULT_ENABLED_ROUTES);
  expect(autorouterAgentEnabled(bb)).toBe(true);
  const policy = JSON.parse(
    (await harness.callAgentTool(
      "kitchen_sink_autorouter_policy",
      {},
      { threadId: "child" },
    )) as string,
  );
  expect(policy.isSubthread).toBe(true);
  expect(policy.currentExecution).toMatchObject({
    model: "gpt-5.6-luna",
    reasoningLevel: "max",
    route: "luna/max",
  });
  expect(policy.projectId).toBe("proj_personal");
  expect(policy.routes.some((route: { route: string }) => route.route.startsWith("fable/"))).toBe(
    false,
  );
  expect(policy.routes.some((route: { route: string }) => route.route === "opus/high")).toBe(true);
  await harness.setSettings({ autorouterModelRouting: false });
  expect(autorouterAgentEnabled(bb)).toBe(false);
  expect(
    JSON.parse(
      (await harness.callAgentTool(
        "kitchen_sink_autorouter_policy",
        {},
        { threadId: "child" },
      )) as string,
    ),
  ).toEqual({ enabled: false });
  expect(usageLimits).toHaveBeenCalledTimes(1);
  expect(
    harness.registrations.instructionProvider?.({ threadId: "child", projectId: "project" }),
  ).toBe(SMART_EMBED_INSTRUCTIONS);
  await harness.dispose();
});
