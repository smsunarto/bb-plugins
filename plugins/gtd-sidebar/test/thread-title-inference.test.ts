import assert from "node:assert/strict";
import { describe, test } from "bun:test";
import {
  completeThreadTitleWithFallback,
  resolveCodexInferenceModels,
} from "../thread-title-inference.ts";

describe("resolveCodexInferenceModels", () => {
  test("uses bb's configured Codex primary and fallback models", () => {
    assert.deepEqual(
      resolveCodexInferenceModels({
        inference: "codex/gpt-primary",
        inferenceFallback: "gtd-sidebar/gpt-fallback",
      }),
      { primary: "gpt-primary", fallback: "gpt-fallback" },
    );
  });

  test("falls back to supported Codex defaults for another inference service", () => {
    assert.deepEqual(
      resolveCodexInferenceModels({
        inference: "anthropic/claude-fast",
        inferenceFallback: "google/gemini-fast",
      }),
      { primary: "gpt-5.6-luna", fallback: "gpt-5.4-mini" },
    );
  });
});

describe("completeThreadTitleWithFallback", () => {
  test("returns the structured title from the primary model", async () => {
    const models: string[] = [];
    const title = await completeThreadTitleWithFallback({
      primary: "primary",
      fallback: "fallback",
      complete: async (model) => {
        models.push(model);
        return { ok: true, model, value: { title: "Fix the login test" } };
      },
    });

    assert.equal(title, "Fix the login test");
    assert.deepEqual(models, ["primary"]);
  });

  test("uses the fallback model after a transient failure", async () => {
    const models: string[] = [];
    const delays: number[] = [];
    const title = await completeThreadTitleWithFallback({
      primary: "primary",
      fallback: "fallback",
      complete: async (model) => {
        models.push(model);
        return model === "primary"
          ? { ok: false, code: "timeout", message: "timed out" }
          : { ok: true, model, value: { title: "Fallback title" } };
      },
      sleep: async (durationMs) => {
        delays.push(durationMs);
      },
    });

    assert.equal(title, "Fallback title");
    assert.deepEqual(models, ["primary", "fallback"]);
    assert.deepEqual(delays, [250]);
  });

  test("does not retry a non-transient failure", async () => {
    const models: string[] = [];

    await assert.rejects(
      completeThreadTitleWithFallback({
        primary: "primary",
        fallback: "fallback",
        complete: async (model) => {
          models.push(model);
          return { ok: false, code: "auth_required", message: "Run codex login" };
        },
      }),
      /Run codex login/u,
    );
    assert.deepEqual(models, ["primary"]);
  });

  test("rejects a structured response without a title", async () => {
    await assert.rejects(
      completeThreadTitleWithFallback({
        primary: "primary",
        fallback: "fallback",
        complete: async (model) => ({ ok: true, model, value: {} }),
      }),
      /returned no title/u,
    );
  });
});
