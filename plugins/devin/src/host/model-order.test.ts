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

test("orders Devin's catalog: Astra and Sol Fusion pairs, headline models, then the rest by vendor", () => {
  const ordered = orderModelCatalog({ models: DEVIN_CATALOG, selectedOnlyModels: [] });
  assert.deepEqual(names(ordered.models), [
    "Fusion (Astra + swe-2-high)",
    "Fusion (Astra + swe-2-medium)",
    "Fusion (Astra + claude-sonnet-5-5-medium)",
    "Fusion (Astra + gpt-6-luna-high)",
    "Fusion (6.1 Sol + swe-2-high)",
    "Fusion (6.1 Sol + swe-2-medium)",
    "Fusion (6.1 Sol + claude-sonnet-5-5-medium)",
    "Fusion (6.1 Sol + gpt-6-luna-high)",
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
  assert.deepEqual(
    names(ordered.selectedOnlyModels),
    DEVIN_CATALOG.filter((m) => /^fusion-(claude|gpt-6-sol)/.test(m.id)).map((m) => m.displayName),
  );
  assert.equal(ordered.selectedOnlyModels.length, 12);
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
  assert.deepEqual(names(ordered.models).slice(4, 11), [
    "Fusion (6.2 Sol + swe-2-high)",
    "GPT-6 Astra",
    "Claude Fable 5.1",
    "GPT-6.2 Sol",
    "Claude Opus 5.5",
    "SWE-2",
    "Claude Sonnet 5.5",
  ]);
  assert.deepEqual(names(ordered.models).slice(11), [
    "GPT-6.1 Sol",
    "GPT-6 Sol",
    "GPT-6 Luna",
    "Grok 4.7",
  ]);
  assert.ok(
    ordered.selectedOnlyModels.some((m) => m.id === "fusion-gpt-6-1-sol-high-sidekick-swe-2-high"),
  );
});

test("a hidden default hands the flag to the first shown model", () => {
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
    [
      ["Fusion (Opus + SWE-2 High)", false],
      ["Claude Haiku 4.5", false],
    ],
  );
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
