import assert from "node:assert/strict";
import { describe, test } from "bun:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { gtdSidebarHostContract } from "../lib/host-contract.ts";
import {
  completeThreadTitleWithFallback,
  createThreadTitleInference,
} from "../thread-title-inference.ts";

describe("thread title inference policy", () => {
  test("calls GPT-5.6-Luna with low reasoning on the primary host", async () => {
    const calls: Array<{ input: Record<string, unknown>; hostId: string }> = [];
    const bb = {
      hosts: {
        experimental_client: () => ({
          call: async (
            _method: string,
            input: Record<string, unknown>,
            options: { hostId: string },
          ) => {
            calls.push({ input, hostId: options.hostId });
            return { ok: true, model: String(input.model), value: { title: "Name threads" } };
          },
        }),
      },
      sdk: {
        system: {
          config: async () => ({ primaryHostId: "host-primary" }),
        },
      },
    } as unknown as BbPluginApi;

    const title = await createThreadTitleInference(bb).complete({
      environmentId: null,
      prompt: "Generate a title",
    });

    assert.equal(title, "Name threads");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.hostId, "host-primary");
    assert.equal(calls[0]?.input.model, "gpt-5.6-luna");
    assert.equal(calls[0]?.input.reasoningEffort, "low");
  });

  test("keeps standard none requests and GTD low requests contract-valid", () => {
    const input = {
      serviceId: "gtd-sidebar",
      model: "gpt-5.6-luna",
      prompt: "Generate a title",
      outputSchema: { type: "object" },
      timeoutMs: 5_000,
    };
    const schema = gtdSidebarHostContract["ai.inference.complete"].input;

    assert.equal(schema.parse({ ...input, reasoningEffort: "none" }).reasoningEffort, "none");
    assert.equal(schema.parse({ ...input, reasoningEffort: "low" }).reasoningEffort, "low");
    assert.throws(() => schema.parse({ ...input, reasoningEffort: "medium" }));
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
