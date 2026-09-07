import assert from "node:assert/strict";
import { describe, test } from "bun:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  completeThreadTitleWithFallback,
  createThreadTitleInference,
  formatInferredTitle,
  TITLE_OUTPUT_SCHEMA,
  type TitleInferenceAttempt,
} from "../thread-title-inference.ts";

describe("thread title inference policy", () => {
  test("calls GPT-5.6-Luna without reasoning on the primary host", async () => {
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
            return {
              ok: true,
              model: String(input.model),
              value: { action: "rename", title: "Name threads" },
            };
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
      allowKeep: true,
    });

    assert.equal(title, "Name threads");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.hostId, "host-primary");
    assert.equal(calls[0]?.input.model, "gpt-5.6-luna");
    assert.deepEqual(calls[0]?.input.outputSchema, TITLE_OUTPUT_SCHEMA);
    assert.deepEqual(Object.keys(TITLE_OUTPUT_SCHEMA.properties), ["action", "title"]);
  });

  test("excludes keep from the first-turn inference schema", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const bb = {
      hosts: {
        experimental_client: () => ({
          call: async (_method: string, input: Record<string, unknown>) => {
            calls.push(input);
            return {
              ok: true,
              model: String(input.model),
              value: { action: "rename", title: "GTD title" },
            };
          },
        }),
      },
      sdk: { system: { config: async () => ({ primaryHostId: "host-primary" }) } },
    } as unknown as BbPluginApi;
    assert.equal(
      await createThreadTitleInference(bb).complete({
        environmentId: null,
        prompt: "Name the first request",
        allowKeep: false,
      }),
      "GTD title",
    );
    assert.deepEqual(
      (calls[0]!.outputSchema as typeof TITLE_OUTPUT_SCHEMA).properties.action.enum,
      ["rename"],
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
        return {
          ok: true,
          model,
          value: { action: "rename", title: "Fix the login test" },
        };
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
          : { ok: true, model, value: { action: "rename", title: "Fallback title" } };
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
      /returned an invalid title/u,
    );
  });

  test("records the model and outcome of every attempt", async () => {
    const attempts: TitleInferenceAttempt[] = [];
    const title = await completeThreadTitleWithFallback({
      primary: "primary",
      fallback: "fallback",
      sleep: async () => {},
      onAttempt: (attempt) => attempts.push(attempt),
      complete: async (model) =>
        model === "primary"
          ? { ok: false, code: "timeout", message: "timed out" }
          : { ok: true, model, value: { action: "rename", title: "Named" } },
    });
    assert.equal(title, "Named");
    assert.deepEqual(
      attempts.map(({ model, attempt, outcome }) => [model, attempt, outcome]),
      [
        ["primary", 0, "timeout"],
        ["fallback", 1, "success"],
      ],
    );
  });

  test("observer errors cannot fail a valid title", async () => {
    assert.equal(
      await completeThreadTitleWithFallback({
        primary: "primary",
        fallback: "fallback",
        onAttempt: () => {
          throw new Error("logger");
        },
        complete: async (model) => ({
          ok: true,
          model,
          value: { action: "rename", title: "Named" },
        }),
      }),
      "Named",
    );
  });
});

test("keeps a title without accepting rewritten fields", () => {
  assert.equal(formatInferredTitle({ action: "keep", title: "Different" }), null);
  assert.throws(() => formatInferredTitle({ action: "invalid", title: "Task" }));
});

test("returns the complete title without adding or rewriting project formatting", () => {
  for (const title of ["Fix sorting", "[Billing] Fix sorting", "[RFC] Retry design", "iOS setup"]) {
    assert.equal(formatInferredTitle({ action: "rename", title }), title);
  }
  assert.throws(() => formatInferredTitle({ action: "rename", title: "  " }));
});
