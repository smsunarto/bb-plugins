import { expect, mock, test } from "bun:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { routeComposerPrompt } from "../lib/autorouter/route-composer.ts";
import { registerAutorouterSettings } from "../lib/autorouter/settings.ts";
import { MODELS, ROUTES } from "../../shared/autorouter/policy.ts";

function setup(
  options: {
    failure?: boolean;
    destinationOnlySol?: boolean;
    enabled?: boolean;
    route?: string;
    providerId?: string;
    settings?: Record<string, boolean | string>;
    fableExhausted?: boolean;
  } = {},
) {
  const complete = mock(async () =>
    options.failure
      ? { ok: false, code: "timeout", message: "Timed out" }
      : {
          ok: true,
          model: "gpt-5.6-luna",
          value: {
            projectId: "target",
            projectConfidence: "high",
            projectReason: "Explicit target",
            route: options.route ?? "astra/high",
            modelConfidence: "high",
            modelReason: "Complex work",
          },
        },
  );
  const host = createFakePluginHost({
    pluginId: "kitchen-sink",
    settings: { autorouterEnabled: options.enabled ?? true, ...options.settings },
    experimental_callHostRpc: complete,
    sdk: {
      system: {
        config: async () => ({ primaryHostId: "primary" }),
        usageLimits: async () => ({
          "claude-code": {
            status: "ok",
            accountEmail: null,
            planLabel: null,
            windows: [
              {
                label: "Fable weekly",
                usedPercent: options.fableExhausted ? 100 : 30,
                resetsAt: null,
              },
            ],
          },
        }),
      },
      projects: {
        list: async () => [
          { id: "source", name: "Source", sources: [{ hostId: "original", isDefault: true }] },
          { id: "target", name: "Target", sources: [{ hostId: "destination", isDefault: true }] },
        ],
      },
      threads: {
        get: async () => ({
          projectId: "source",
          environmentId: "environment",
          providerId: options.providerId ?? "codex",
        }),
      },
      environments: { get: async () => ({ id: "environment", hostId: "thread-host" }) },
      providers: {
        models: async (args) => ({
          providers: [
            {
              id: args?.providerId,
              displayName: args?.providerId,
              available: true,
              strings: { brandPrefix: "GPT-" },
              reasoningLevels: [
                { id: "high", label: "High" },
                { id: "medium", label: "Medium" },
              ],
            },
          ],
          models: MODELS.filter(
            (model) =>
              model.providerId === args?.providerId &&
              (!options.destinationOnlySol || args.hostId !== "destination" || model.key === "sol"),
          ).map((model) => ({
            model: model.model,
            displayName: `GPT-${model.label}`,
            supportedReasoningEfforts: ROUTES.filter((route) => route.model === model.model).map(
              (route) => ({ reasoningEffort: route.reasoningLevel }),
            ),
          })),
        }),
      },
    },
  });
  registerAutorouterSettings(host.bb);
  return { ...host, complete };
}

test("one host RPC runs Luna medium on the primary host and validates the destination catalog", async () => {
  const { bb, harness, complete } = setup();
  const result = await routeComposerPrompt(bb, {
    prompt: "In Target, design a system",
    scope: { kind: "new-thread", projectId: "source" },
  });
  expect(result).toMatchObject({
    projectId: "target",
    execution: { model: "gpt-6-astra", reasoningLevel: "high", modelLabel: "Astra" },
    usedFallback: false,
  });
  expect(complete).toHaveBeenCalledTimes(1);
  expect(harness.experimental_hostRpcCalls[0]).toMatchObject({
    method: "complete",
    hostId: "primary",
    input: { model: "gpt-5.6-luna", reasoningEffort: "medium", timeoutMs: 20_000 },
  });
  expect(harness.sdk.callsTo("providers.models")).toContainEqual([
    { providerId: "codex", hostId: "destination" },
  ]);
  await harness.dispose();
});

test("destination without the chosen model uses its configured fallback without a second inference", async () => {
  const { bb, harness, complete } = setup({
    destinationOnlySol: true,
    settings: {
      autorouterModel_sol: true,
      autorouterRoute_sol_medium: true,
      autorouterFallback: "sol/medium",
    },
  });
  const result = await routeComposerPrompt(bb, {
    prompt: "Work in Target",
    scope: { kind: "new-thread", projectId: "source" },
  });
  expect(result).toMatchObject({
    projectId: "target",
    execution: { model: "gpt-5.6-sol", reasoningLevel: "medium" },
    usedFallback: true,
  });
  expect(complete).toHaveBeenCalledTimes(1);
  await harness.dispose();
});

test("transport failure keeps the current project and applies the fallback", async () => {
  const { bb, harness, complete } = setup({ failure: true });
  const result = await routeComposerPrompt(bb, {
    prompt: "A task",
    scope: { kind: "new-thread", projectId: "source" },
  });
  expect(result).toMatchObject({
    projectId: "source",
    execution: { route: "astra/medium" },
    usedFallback: true,
  });
  expect(complete).toHaveBeenCalledTimes(1);
  await harness.dispose();
});

test("follow-up uses the thread environment and keeps its project and provider", async () => {
  const { bb, harness } = setup();
  const result = await routeComposerPrompt(bb, {
    prompt: "Mention Target",
    scope: {
      kind: "thread",
      threadId: "thread",
      selectionTitle: "codex: Astra · Medium reasoning",
    },
  });
  expect(result?.projectId).toBe("source");
  expect(harness.sdk.callsTo("providers.models")).toContainEqual([
    { providerId: "codex", environmentId: "environment" },
  ]);
  expect(harness.sdk.callsTo("providers.models")).toHaveLength(1);
  await harness.dispose();
});

test("turning the persisted setting off prevents a stale client from running inference", async () => {
  const { bb, harness, complete } = setup({ enabled: false });
  await expect(
    routeComposerPrompt(bb, {
      prompt: "A task",
      scope: { kind: "new-thread", projectId: "source" },
    }),
  ).rejects.toThrow("Autorouter is disabled");
  expect(complete).not.toHaveBeenCalled();
  await harness.dispose();
});

test.each([
  "codex: 5.6 Sol · High reasoning",
  "claude-code: Fable · High reasoning",
  "unknown selection",
])("server skips non-Astra follow-ups without inference: %s", async (selectionTitle) => {
  const { bb, harness, complete } = setup();
  expect(
    await routeComposerPrompt(bb, {
      prompt: "Task",
      scope: { kind: "thread", threadId: "thread", selectionTitle },
    }),
  ).toBeNull();
  expect(complete).not.toHaveBeenCalled();
  await harness.dispose();
});

test.each([{ failure: true }, { route: "sol/low" }, { route: "fable/high" }])(
  "Astra follow-up failure or invalid model keeps its current reasoning: %j",
  async (options) => {
    const { bb, harness, complete } = setup(options);
    const result = await routeComposerPrompt(bb, {
      prompt: "Task",
      scope: {
        kind: "thread",
        threadId: "thread",
        selectionTitle: "codex: Astra · Medium reasoning",
      },
    });
    expect(result).toMatchObject({
      projectId: "source",
      execution: { model: "gpt-6-astra", route: "astra/medium" },
      usedFallback: true,
    });
    expect(complete).toHaveBeenCalledTimes(1);
    const request = harness.experimental_hostRpcCalls[0]!.input as { prompt: string };
    expect(request.prompt).toContain("This is a follow-up");
    expect(request.prompt).not.toContain('"route":"sol/');
    expect(request.prompt).not.toContain('"route":"fable/');
    await harness.dispose();
  },
);

test("Luna Max can escalate to Astra but Astra cannot route to Luna", async () => {
  const up = setup();
  expect(
    (
      await routeComposerPrompt(up.bb, {
        prompt: "Hard bug",
        scope: {
          kind: "thread",
          threadId: "thread",
          selectionTitle: "codex: 5.6 Luna · max reasoning",
        },
      })
    )?.execution?.route,
  ).toBe("astra/high");
  const down = setup({ route: "luna/max" });
  expect(
    (
      await routeComposerPrompt(down.bb, {
        prompt: "Commit",
        scope: {
          kind: "thread",
          threadId: "thread",
          selectionTitle: "codex: Astra · Medium reasoning",
        },
      })
    )?.execution?.route,
  ).toBe("astra/medium");
  await up.harness.dispose();
  await down.harness.dispose();
});

test.each([
  {
    settings: { autorouterModelRouting: false },
    expected: { projectId: "target", execution: null },
  },
  {
    settings: { autorouterProjectRouting: false },
    expected: { projectId: "source", execution: { route: "astra/high" } },
  },
  {
    settings: { autorouterRoute_astra_high: false },
    expected: { execution: { route: "astra/medium" } },
  },
  { settings: { autorouterModel_astra: false }, expected: { execution: { route: "luna/max" } } },
])("server enforces routing switches: %j", async ({ settings, expected }) => {
  const f = setup({
    settings: Object.fromEntries(
      Object.entries(settings).filter(
        (entry): entry is [string, boolean] => entry[1] !== undefined,
      ),
    ),
  });
  expect(
    await routeComposerPrompt(f.bb, {
      prompt: "Task",
      scope: { kind: "new-thread", projectId: "source" },
    }),
  ).toMatchObject(expected);
  await f.harness.dispose();
});

test.each([false, true])(
  "Opus only becomes eligible when Fable usage is exhausted: %s",
  async (fableExhausted) => {
    const f = setup({ route: "opus/high", fableExhausted });
    expect(
      (
        await routeComposerPrompt(f.bb, {
          prompt: "Design UI",
          scope: { kind: "new-thread", projectId: "source" },
        })
      )?.execution?.route,
    ).toBe(fableExhausted ? "opus/high" : "astra/medium");
    await f.harness.dispose();
  },
);
