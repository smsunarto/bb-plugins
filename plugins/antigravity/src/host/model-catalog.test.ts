import assert from "node:assert/strict";
import { test } from "node:test";
import type { AvailableModel } from "@get-bb/plugin-sdk/provider-bridge";
import {
  isVisibleAntigravityModel,
  createModelListEnricher,
  parseAgyModelsOutput,
  transformAntigravityModelCatalog,
} from "./model-catalog.ts";

const SAMPLE_AGY_MODELS = [
  "gemini-4-neon-high             Gemini 4 Neon (High)",
  "gemini-4-neon-xhigh            Gemini 4 Neon (XHigh)",
  "gemini-4-neon-medium           Gemini 4 Neon (Medium)",
  "gemini-4-neon-low              Gemini 4 Neon (Low)",
  "gemini-4-carbon-medium         Gemini 4 Carbon (Medium)",
  "gemini-4-carbon-high           Gemini 4 Carbon (High)",
  "gemini-4-carbon-low            Gemini 4 Carbon (Low)",
  "gemini-pro-orchestrator-neon   Orchestrator (Neon)",
  "gemini-3.8-flash-high          Gemini 3.8 Flash (High)",
  "gemini-3.8-flash-low           Gemini 3.8 Flash (Low)",
  "claude-opus-5-5-low            Claude Opus 5.5 (Low)",
  "claude-opus-5-5-high           Claude Opus 5.5 (High)",
  "gpt-oss-120b-medium            GPT-OSS 120B (Medium)",
].join("\n");

function makeModel(
  overrides: Partial<AvailableModel> & Pick<AvailableModel, "id">,
): AvailableModel {
  return {
    model: overrides.id,
    displayName: overrides.id,
    description: "",
    reasoningDiscovery: "unknown",
    supportedReasoningEfforts: [],
    defaultReasoningEffort: "medium",
    supportedServiceTiers: [],
    isDefault: false,
    ...overrides,
  };
}

test("parseAgyModelsOutput extracts per-family efforts, defaults, and exact-only models", () => {
  const parsed = parseAgyModelsOutput(SAMPLE_AGY_MODELS);

  assert.deepEqual(parsed.effortsByFamily.get("gemini-4-neon"), {
    efforts: ["low", "medium", "high", "xhigh"],
    defaultEffort: "high",
  });
  assert.deepEqual(parsed.effortsByFamily.get("gemini-4-carbon"), {
    efforts: ["low", "medium", "high"],
    defaultEffort: "medium",
  });
  assert.equal(parsed.exactModelIds.has("gemini-pro-orchestrator-neon"), true);
  assert.equal(parsed.exactModelIds.has("gpt-oss-120b-medium"), true);
});

test("parseAgyModelsOutput parses tab-separated piped output from agy models", () => {
  const piped = [
    "gemini-4-carbon-medium\tGemini 4 Carbon (Medium)",
    "gemini-4-carbon-high\tGemini 4 Carbon (High)",
    "gemini-4-carbon-low\tGemini 4 Carbon (Low)",
    "gemini-pro-orchestrator-neon\tOrchestrator (Neon)",
  ].join("\n");
  const parsed = parseAgyModelsOutput(piped);
  assert.deepEqual(parsed.effortsByFamily.get("gemini-4-carbon"), {
    efforts: ["low", "medium", "high"],
    defaultEffort: "medium",
  });
  assert.equal(parsed.exactModelIds.has("gemini-pro-orchestrator-neon"), true);
});

test("transformAntigravityModelCatalog keeps Neon, Carbon, and orchestrators, enriches reasoning, and strips mode", () => {
  const parsed = parseAgyModelsOutput(SAMPLE_AGY_MODELS);
  const modeOption = {
    id: "mode",
    label: "Mode",
    category: "mode",
    type: "select" as const,
    value: "default",
    values: [{ id: "default", label: "Default" }],
  };

  const catalog = transformAntigravityModelCatalog(
    {
      models: [
        makeModel({ id: "gpt-oss-120b-medium", sessionOptions: [modeOption] }),
        makeModel({ id: "claude-opus-5-5", sessionOptions: [modeOption] }),
        makeModel({ id: "gemini-pro-orchestrator-neon", sessionOptions: [modeOption] }),
        makeModel({ id: "gemini-3.8-flash", sessionOptions: [modeOption] }),
        makeModel({ id: "gemini-4-carbon", sessionOptions: [modeOption] }),
        makeModel({
          id: "gemini-4-neon",
          isDefault: true,
          reasoningDiscovery: "known",
          defaultReasoningEffort: "high",
          supportedReasoningEfforts: [
            { reasoningEffort: "high", label: "High", description: "High" },
          ],
          sessionOptions: [modeOption],
        }),
      ],
      selectedOnlyModels: [],
    },
    parsed,
  );

  assert.deepEqual(
    catalog.models.map((m) => m.id),
    ["gemini-4-carbon", "gemini-4-neon", "gemini-pro-orchestrator-neon"],
  );

  const carbon = catalog.models.find((m) => m.id === "gemini-4-carbon")!;
  assert.equal(carbon.reasoningDiscovery, "known");
  assert.equal(carbon.defaultReasoningEffort, "medium");
  assert.deepEqual(
    carbon.supportedReasoningEfforts.map((e) => e.reasoningEffort),
    ["low", "medium", "high"],
  );
  assert.deepEqual(carbon.sessionOptions, []);

  // The orchestrator resolves as known with no selectable efforts.
  const orchestrator = catalog.models.find((m) => m.id === "gemini-pro-orchestrator-neon")!;
  assert.equal(orchestrator.reasoningDiscovery, "known");
  assert.deepEqual(orchestrator.supportedReasoningEfforts, []);
});

test("transformAntigravityModelCatalog hides every model except Neon, Carbon, and their orchestrators", () => {
  const ids = [
    "gemini-4-neon",
    "gemini-4-carbon",
    "gemini-4-argon",
    "gemini-4-hydrogen",
    "gemini-3.8-flash",
    "gemini-pro-orchestrator-neon",
    "gemini-pro-orchestrator",
    "gemini-pro-orchestrator-argon",
    "claude-opus-5-5",
    "claude-sonnet-5-5",
    "gpt-oss-120b-medium",
  ];
  const catalog = transformAntigravityModelCatalog(
    {
      models: ids.map((id) => makeModel({ id, isDefault: id === "gemini-4-argon" })),
      selectedOnlyModels: [
        makeModel({ id: "claude-opus-5-5" }),
        makeModel({ id: "gemini-4-neon-high" }),
      ],
    },
    null,
  );

  assert.deepEqual(
    catalog.models.map((m) => m.id),
    ["gemini-4-neon", "gemini-4-carbon", "gemini-pro-orchestrator-neon", "gemini-pro-orchestrator"],
  );
  // A hidden default hands the default to the first visible model.
  assert.deepEqual(
    catalog.models.filter((m) => m.isDefault).map((m) => m.id),
    ["gemini-4-neon"],
  );
  assert.deepEqual(
    catalog.selectedOnlyModels.map((m) => m.id),
    ["gemini-4-neon-high"],
  );
  assert.equal(isVisibleAntigravityModel("gemini-4-carbon-high"), true);
  assert.equal(isVisibleAntigravityModel("gemini-4-argon"), false);
});

test("createModelListEnricher intercepts and enriches matching model/list responses", async () => {
  const enricher = createModelListEnricher({
    fetchModelsOutput: async () => SAMPLE_AGY_MODELS,
  });

  enricher.beforeInbound(
    JSON.stringify({ jsonrpc: "2.0", id: 7, method: "model/list", params: {} }),
    "agy",
  );

  let written = "";
  const intercepted = enricher.interceptOutbound(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      result: {
        models: [makeModel({ id: "gemini-4-carbon" })],
        selectedOnlyModels: [],
      },
    })}\n`,
    (chunk) => {
      written = chunk;
    },
  );

  assert.equal(intercepted, true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const response = JSON.parse(written);
  assert.equal(response.result.models[0].reasoningDiscovery, "known");
  assert.equal(response.result.models[0].defaultReasoningEffort, "medium");
});
