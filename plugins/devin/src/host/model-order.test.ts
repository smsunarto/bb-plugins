import { test } from "node:test";
import assert from "node:assert/strict";
import type { AvailableModel } from "@get-bb/plugin-sdk/provider-bridge";
import { createModelListRewriter, orderModelCatalog } from "./model-order.ts";

function model(id: string, displayName: string, isDefault = false): AvailableModel {
  return {
    id,
    model: id,
    displayName,
    description: "",
    supportedReasoningEfforts: [],
    defaultReasoningEffort: "medium",
    isDefault,
  };
}

// Devin CLI 3000.11.3's catalog, in Devin's order. GPT-6.1 Sol is its default.
const DEVIN_CATALOG: AvailableModel[] = [
  model("swe-2-high", "SWE-2"),
  model("claude-fable-5-1-medium", "Claude Fable 5.1"),
  model("claude-opus-5-5-medium", "Claude Opus 5.5"),
  model("gpt-6-astra-medium", "GPT-6 Astra"),
  model("gpt-6-sol-medium", "GPT-6 Sol"),
  model("gpt-6-luna-medium", "GPT-6 Luna"),
  model("claude-sonnet-5-5-medium", "Claude Sonnet 5.5"),
  model("gpt-6-1-sol-medium", "GPT-6.1 Sol", true),
  model("grok-4-7-medium", "Grok 4.7"),
  ...["swe-2-medium", "gpt-6-luna-high", "swe-2-high", "claude-sonnet-5-5-medium"].flatMap(
    (sidekick) => [
      model(`fusion-claude-fable-5-1-medium-sidekick-${sidekick}`, `Fusion (Fable + ${sidekick})`),
      model(`fusion-claude-opus-5-5-high-sidekick-${sidekick}`, `Fusion (Opus + ${sidekick})`),
      model(`fusion-gpt-6-astra-high-sidekick-${sidekick}`, `Fusion (Astra + ${sidekick})`),
      model(`fusion-gpt-6-sol-high-sidekick-${sidekick}`, `Fusion (6 Sol + ${sidekick})`),
      model(`fusion-gpt-6-1-sol-high-sidekick-${sidekick}`, `Fusion (6.1 Sol + ${sidekick})`),
    ],
  ),
];

const names = (models: readonly AvailableModel[]) => models.map((m) => m.displayName);
const fusionIds = (models: readonly AvailableModel[]) =>
  models.filter((m) => m.id.startsWith("fusion-")).map((m) => m.id);

test("orders Devin's catalog: one Fusion pair per latest Astra and Sol, headline models, then the rest by vendor", () => {
  const ordered = orderModelCatalog({ models: DEVIN_CATALOG, selectedOnlyModels: [] });
  assert.deepEqual(names(ordered.models), [
    "Fusion (Astra + swe-2-high)",
    "Fusion (6.1 Sol + swe-2-high)",
    "GPT-6 Astra",
    "Claude Fable 5.1",
    "GPT-6.1 Sol",
    "Claude Opus 5.5",
    "SWE-2",
    "Claude Sonnet 5.5",
    "GPT-6 Sol",
    "GPT-6 Luna",
    "Grok 4.7",
  ]);
  assert.equal(ordered.models.find((m) => m.isDefault)?.displayName, "GPT-6.1 Sol");
  assert.deepEqual(ordered.selectedOnlyModels, []);
});

test("a newer version takes its family's slots without a table change", () => {
  const ordered = orderModelCatalog({
    models: [
      ...DEVIN_CATALOG,
      model("gpt-6-2-sol-medium", "GPT-6.2 Sol"),
      model("fusion-gpt-6-2-sol-high-sidekick-swe-2-high", "Fusion (6.2 Sol + swe-2-high)"),
    ],
    selectedOnlyModels: [],
  });
  assert.deepEqual(names(ordered.models), [
    "Fusion (Astra + swe-2-high)",
    "Fusion (6.2 Sol + swe-2-high)",
    "GPT-6 Astra",
    "Claude Fable 5.1",
    "GPT-6.2 Sol",
    "Claude Opus 5.5",
    "SWE-2",
    "Claude Sonnet 5.5",
    "GPT-6.1 Sol",
    "GPT-6 Sol",
    "GPT-6 Luna",
    "Grok 4.7",
  ]);
  assert.deepEqual(fusionIds(ordered.models), [
    "fusion-gpt-6-astra-high-sidekick-swe-2-high",
    "fusion-gpt-6-2-sol-high-sidekick-swe-2-high",
  ]);
  assert.deepEqual(fusionIds(ordered.selectedOnlyModels), []);
});

test("an omitted default hands the flag to the first shown model", () => {
  const ordered = orderModelCatalog({
    models: [
      model("gpt-6-astra-medium", "GPT-6 Astra"),
      model("fusion-claude-opus-5-5-high-sidekick-swe-2-high", "Fusion (Opus + SWE-2 High)", true),
      model("fusion-gpt-6-astra-high-sidekick-swe-2-high", "Fusion (Astra + SWE-2 High)"),
    ],
    selectedOnlyModels: [model("claude-haiku-4-5-medium", "Claude Haiku 4.5", true)],
  });
  assert.deepEqual(
    ordered.models.map((m) => [m.displayName, m.isDefault]),
    [
      ["Fusion (Astra + SWE-2 High)", true],
      ["GPT-6 Astra", false],
    ],
  );
  assert.deepEqual(
    ordered.selectedOnlyModels.map((m) => [m.displayName, m.isDefault]),
    [["Claude Haiku 4.5", false]],
  );
});

test("a standalone SWE-2 Max does not create a stronger Fusion pair", () => {
  const ordered = orderModelCatalog({
    models: [...DEVIN_CATALOG, model("swe-2-max", "SWE-2 Max")],
    selectedOnlyModels: [],
  });
  assert.deepEqual(fusionIds(ordered.models), [
    "fusion-gpt-6-astra-high-sidekick-swe-2-high",
    "fusion-gpt-6-1-sol-high-sidekick-swe-2-high",
  ]);
});

test("a stronger advertised sidekick wins per primary", () => {
  const ordered = orderModelCatalog({
    models: [
      ...DEVIN_CATALOG,
      model(
        "fusion-gpt-6-astra-high-sidekick-swe-2-max",
        "Fusion (GPT-6 Astra High Thinking + SWE-2 Max)",
      ),
    ],
    selectedOnlyModels: [],
  });
  assert.deepEqual(fusionIds(ordered.models), [
    "fusion-gpt-6-astra-high-sidekick-swe-2-max",
    "fusion-gpt-6-1-sol-high-sidekick-swe-2-high",
  ]);
  assert.equal(ordered.models[0]?.displayName, "Fusion (GPT-6 Astra + SWE-2 Max)");
  assert.deepEqual(fusionIds(ordered.selectedOnlyModels), []);
});

test("each primary falls back to its strongest advertised SWE-2 sidekick", () => {
  const ordered = orderModelCatalog({
    models: DEVIN_CATALOG.filter((m) => m.id !== "fusion-gpt-6-1-sol-high-sidekick-swe-2-high"),
    selectedOnlyModels: [],
  });
  assert.deepEqual(fusionIds(ordered.models), [
    "fusion-gpt-6-astra-high-sidekick-swe-2-high",
    "fusion-gpt-6-1-sol-high-sidekick-swe-2-medium",
  ]);
});

test("without SWE-2 Fusion pairs the picker offers no Fusion at all", () => {
  const ordered = orderModelCatalog({
    models: DEVIN_CATALOG.filter((m) => !m.id.includes("-sidekick-swe-")),
    selectedOnlyModels: [],
  });
  assert.deepEqual(names(ordered.models), [
    "GPT-6 Astra",
    "Claude Fable 5.1",
    "GPT-6.1 Sol",
    "Claude Opus 5.5",
    "SWE-2",
    "Claude Sonnet 5.5",
    "GPT-6 Sol",
    "GPT-6 Luna",
    "Grok 4.7",
  ]);
  assert.deepEqual(ordered.selectedOnlyModels, []);
});

test("an id outside the tables sorts after the known vendors", () => {
  const ordered = orderModelCatalog({
    models: [
      model("auto", "Auto"),
      model("gemini-4-pro-medium", "Gemini 4 Pro"),
      model("grok-4-7-medium", "Grok 4.7"),
      model("gpt-6-luna-medium", "GPT-6 Luna"),
    ],
    selectedOnlyModels: [],
  });
  assert.deepEqual(names(ordered.models), ["GPT-6 Luna", "Grok 4.7", "Gemini 4 Pro", "Auto"]);
});

test("the wire rewrite keeps a shown Fusion pair's native id, effort metadata, and drops the baked-in lead effort", () => {
  const fusion = {
    ...model(
      "fusion-gpt-6-astra-high-sidekick-swe-2-high",
      "Fusion (GPT-6 Astra High Thinking + SWE-2 High)",
    ),
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Low" },
      { reasoningEffort: "medium", description: "Medium" },
      { reasoningEffort: "high", description: "High" },
      { reasoningEffort: "xhigh", description: "XHigh" },
      { reasoningEffort: "max", description: "Max" },
    ],
    defaultReasoningEffort: "high",
  } satisfies AvailableModel;
  const rewriter = createModelListRewriter();
  rewriter.beforeInbound(
    `${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "model/list", params: {} })}\n`,
  );
  const answer = `${JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    result: {
      models: [
        model("gpt-6-astra-medium", "GPT-6 Astra", true),
        model("fusion-gpt-6-astra-medium-sidekick-swe-2-medium", "Fusion (Astra + swe-2-medium)"),
        model(
          "fusion-gpt-6-astra-high-sidekick-gpt-6-luna-high",
          "Fusion (Astra + gpt-6-luna-high)",
        ),
        fusion,
      ],
      selectedOnlyModels: [
        model("fusion-claude-opus-5-5-high-sidekick-swe-2-high", "Fusion (Opus + SWE-2 High)"),
        model("claude-haiku-4-5-medium", "Claude Haiku 4.5", true),
      ],
    },
  })}\n`;

  const rewritten = JSON.parse(rewriter.rewrite(answer)) as {
    result: { models: AvailableModel[]; selectedOnlyModels: AvailableModel[] };
  };
  assert.deepEqual(
    rewritten.result.models.map((m) => m.id),
    ["fusion-gpt-6-astra-high-sidekick-swe-2-high", "gpt-6-astra-medium"],
  );
  const shown = rewritten.result.models[0]!;
  assert.equal(shown.id, "fusion-gpt-6-astra-high-sidekick-swe-2-high");
  assert.equal(shown.model, "fusion-gpt-6-astra-high-sidekick-swe-2-high");
  assert.equal(shown.displayName, "Fusion (GPT-6 Astra + SWE-2 High)");
  assert.equal(shown.defaultReasoningEffort, "high");
  assert.deepEqual(
    shown.supportedReasoningEfforts.map((effort) => effort.reasoningEffort),
    ["low", "medium", "high", "xhigh", "max"],
  );
  assert.equal(shown.isDefault, false);
  assert.equal(rewritten.result.models[1]?.isDefault, true);
  assert.deepEqual(
    rewritten.result.selectedOnlyModels.map((m) => m.id),
    ["claude-haiku-4-5-medium"],
  );
  assert.equal(rewritten.result.selectedOnlyModels[0]?.isDefault, false);
});

test("the rewriter reorders only the answer to bb's model/list request", () => {
  const rewriter = createModelListRewriter((catalog) => ({
    models: [...catalog.models].reverse(),
    selectedOnlyModels: [model("hidden", "Hidden")],
  }));
  const answer = (id: number) =>
    `${JSON.stringify({ jsonrpc: "2.0", id, result: { models: [model("a", "A"), model("b", "B")], selectedOnlyModels: [] } })}\n`;
  const delta = `${JSON.stringify({ jsonrpc: "2.0", method: "thread/delta", params: { threadId: "t", deltas: [] } })}\n`;

  assert.equal(rewriter.rewrite(answer(7)), answer(7), "nothing pending: pass through");
  rewriter.beforeInbound(
    JSON.stringify({ jsonrpc: "2.0", id: 7, method: "model/list", params: {} }),
  );
  assert.equal(rewriter.rewrite(delta), delta);
  assert.equal(rewriter.rewrite(answer(8)), answer(8), "another request's answer");
  const rewritten = rewriter.rewrite(answer(7));
  assert.ok(rewritten.endsWith("\n"));
  assert.deepEqual(JSON.parse(rewritten), {
    jsonrpc: "2.0",
    id: 7,
    result: {
      models: [model("b", "B"), model("a", "A")],
      selectedOnlyModels: [model("hidden", "Hidden")],
    },
  });
  assert.equal(rewriter.rewrite(answer(7)), answer(7), "an id answers once");
});
