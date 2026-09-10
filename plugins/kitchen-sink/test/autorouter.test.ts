import { expect, mock, test } from "bun:test";
import {
  DEFAULT_MODEL_RULES,
  DEFAULT_GENERAL_RULE,
  DEFAULT_ENABLED_ROUTES,
  DEFAULT_ROUTE,
  ROUTES,
  projectIndexSchema,
  resolveRoutingDecision,
} from "../src/shared/autorouter/policy.ts";
import { routePrompt, type RouterInference } from "../src/server/lib/autorouter/router.ts";
import type { AutorouterSettings } from "../src/server/lib/autorouter/settings.ts";

const settings: AutorouterSettings = {
  enabled: true,
  modelRouting: true,
  projectRouting: true,
  generalRule: DEFAULT_GENERAL_RULE,
  enabledRoutes: DEFAULT_ENABLED_ROUTES,
  fallback: DEFAULT_ROUTE,
  projects: [],
  rules: DEFAULT_MODEL_RULES,
};
const projects = [{ id: "plugins", name: "bb-plugins", repositories: [] }];
const availableRouteIds = new Set(ROUTES.map((route) => route.id));
const decision = {
  projectId: "plugins",
  projectConfidence: "high",
  projectReason: "Explicit repository target.",
  route: "astra/high",
  modelConfidence: "high",
  modelReason: "Complex architecture work.",
};

test("one Luna medium completion routes both project and model, overriding current selections", async () => {
  const complete = mock<RouterInference["complete"]>(async () => decision);
  const result = await routePrompt({
    prompt: "In bb-plugins, design a plugin dependency resolver.",
    currentProjectId: "old-project",
    projects,
    settings,
    availableRouteIds,
    inference: { complete },
  });
  expect(complete).toHaveBeenCalledTimes(1);
  expect(complete.mock.calls[0]?.[0]).toMatchObject({
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
  });
  expect(result).toMatchObject({
    projectId: "plugins",
    execution: { model: "gpt-6-astra", reasoningLevel: "high" },
    usedFallback: false,
  });
});

test.each([null, { ...decision, route: "luna/low" }, { ...decision, modelConfidence: "low" }])(
  "invalid or uncertain model uses the configured fallback: %j",
  (value) => {
    expect(
      resolveRoutingDecision({
        decision: value,
        currentProjectId: "current",
        projectIds: new Set(["plugins"]),
        availableRouteIds,
        fallback: "opus/medium",
      }),
    ).toMatchObject({
      execution: { model: "claude-opus-5[1m]", reasoningLevel: "medium" },
      usedFallback: true,
    });
  },
);

test("low project confidence keeps the current project independently of a confident model", () => {
  expect(
    resolveRoutingDecision({
      decision: { ...decision, projectConfidence: "low" },
      currentProjectId: "current",
      projectIds: new Set(["plugins"]),
      availableRouteIds,
      fallback: DEFAULT_ROUTE,
    }),
  ).toMatchObject({
    projectId: "current",
    execution: { route: "astra/high" },
    usedFallback: false,
  });
});

test("stale projects and unavailable inferred models do not escape validation", () => {
  expect(
    resolveRoutingDecision({
      decision,
      currentProjectId: "current",
      projectIds: new Set(),
      availableRouteIds: new Set([DEFAULT_ROUTE]),
      fallback: DEFAULT_ROUTE,
    }),
  ).toMatchObject({
    projectId: "current",
    execution: { route: DEFAULT_ROUTE },
    usedFallback: true,
  });
});

test("an unavailable fallback blocks routing with an actionable error", () => {
  expect(() =>
    resolveRoutingDecision({
      decision: null,
      currentProjectId: null,
      projectIds: new Set(),
      availableRouteIds: new Set(),
      fallback: DEFAULT_ROUTE,
    }),
  ).toThrow("No enabled autorouter model");
});

test("transport failure uses the fallback without a retry", async () => {
  const complete = mock(async () => {
    throw new Error("timeout");
  });
  expect(
    await routePrompt({
      prompt: "Fix the bug.",
      currentProjectId: "current",
      projects,
      settings,
      availableRouteIds,
      inference: { complete },
    }),
  ).toMatchObject({
    projectId: "current",
    execution: { route: DEFAULT_ROUTE },
    usedFallback: true,
  });
  expect(complete).toHaveBeenCalledTimes(1);
});

test("attachment-only prompts use the fallback without sending empty inference", async () => {
  const complete = mock(async () => decision);
  expect(
    await routePrompt({
      prompt: " ",
      currentProjectId: null,
      projects,
      settings,
      availableRouteIds,
      inference: { complete },
    }),
  ).toMatchObject({ projectId: null, usedFallback: true });
  expect(complete).not.toHaveBeenCalled();
});

test("the project index requires three distinct single-line tasks and unique host paths", () => {
  const entry = {
    repository: "bb-plugins",
    path: "/git/bb-plugins",
    hostId: "host",
    projectId: "plugins",
    summary: "BB plugins.",
    examples: ["Fix sidebar.", "Add composer action.", "Update theme."],
  };
  expect(projectIndexSchema.safeParse([entry]).success).toBe(true);
  expect(
    projectIndexSchema.safeParse([
      { ...entry, examples: ["Fix sidebar.", "Fix sidebar.", "Update theme."] },
    ]).success,
  ).toBe(false);
  expect(projectIndexSchema.safeParse([{ ...entry, summary: "Two\nlines" }]).success).toBe(false);
  expect(projectIndexSchema.safeParse([entry, entry]).success).toBe(false);
});

test("disabled project and model dimensions are enforced independently of inference", async () => {
  const infer = mock(async () => decision);
  const run = (override: Partial<AutorouterSettings>) =>
    routePrompt({
      prompt: "Task",
      currentProjectId: "current",
      projects,
      settings: { ...settings, ...override },
      availableRouteIds,
      inference: { complete: infer },
    });
  expect(await run({ modelRouting: false })).toMatchObject({
    projectId: "plugins",
    execution: null,
    usedFallback: false,
  });
  expect(await run({ projectRouting: false })).toMatchObject({
    projectId: "current",
    execution: { route: "astra/high" },
  });
});

test("a disabled fallback uses an enabled route and current follow-up effort can be preserved", () => {
  const input = {
    decision: null,
    currentProjectId: null,
    projectIds: new Set<string>(),
    availableRouteIds: new Set(["astra/high"]),
    fallback: "sol/medium",
  };
  expect(resolveRoutingDecision(input).execution?.route).toBe("astra/high");
  expect(resolveRoutingDecision({ ...input, preserveRoute: "luna/max" }).execution?.route).toBe(
    "luna/max",
  );
});
