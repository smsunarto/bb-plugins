import assert from "node:assert/strict";
import { describe, test } from "bun:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { gtdSidebarHostContract } from "../lib/host-contract.ts";
import {
  completeThreadTitleWithFallback,
  createThreadTitleInference,
  formatInferredTitle,
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
              value: { activity: "explore", scope: "", title: "Name threads" },
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
    });

    assert.equal(title, "Name threads");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.hostId, "host-primary");
    assert.equal(calls[0]?.input.model, "gpt-5.6-luna");
    assert.equal(calls[0]?.input.reasoningEffort, "none");
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
        return {
          ok: true,
          model,
          value: { activity: "explore", scope: "", title: "Fix the login test" },
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
          : { ok: true, model, value: { activity: "explore", scope: "", title: "Fallback title" } };
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

  test("records failed and successful attempts without inventing missing usage", async () => {
    const attempts: unknown[] = [];
    const title = await completeThreadTitleWithFallback({
      primary: "primary",
      fallback: "fallback",
      sleep: async () => {},
      onAttempt: (attempt) => attempts.push(attempt),
      complete: async (model) =>
        model === "primary"
          ? { ok: false, code: "timeout", message: "timed out" }
          : {
              ok: true,
              model,
              value: { activity: "explore", scope: "", title: "Named" },
              usage: { inputTokens: 20, outputTokens: 5 },
            },
    });
    assert.equal(title, "Named");
    assert.equal(attempts.length, 2);
    assert.deepEqual((attempts[0] as { usage?: unknown }).usage, undefined);
    assert.deepEqual((attempts[1] as { usage: unknown }).usage, {
      inputTokens: 20,
      outputTokens: 5,
    });
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
          value: { activity: "explore", scope: "", title: "Named" },
        }),
      }),
      "Named",
    );
  });
});

test("formats activity and multiple scopes deterministically", () => {
  assert.equal(
    formatInferredTitle({
      activity: "fix",
      scope: "Invoices + Accounts",
      title: "Sorting and selection fixes",
    }),
    "🐛 [Invoices + Accounts] Sorting and selection fixes",
  );
  assert.equal(
    formatInferredTitle({
      activity: "explore",
      scope: "Editor",
      title: "Can TextMate distinguish symbols?",
    }),
    "[Editor] Can TextMate distinguish symbols?",
  );
  assert.throws(() => formatInferredTitle({ activity: "🔥", scope: "", title: "Task" }));
});

test("front-loads task nouns without cutting identifiers or questions", () => {
  assert.equal(
    formatInferredTitle({
      activity: "review",
      scope: "Snapshots",
      title: "Review snapshot writer races",
    }),
    "🔎 [Snapshots] Snapshot writer races",
  );
  assert.equal(
    formatInferredTitle({
      activity: "build",
      scope: "",
      title: "Continue CSV export implementation",
    }),
    "🛠️ CSV export implementation",
  );
  assert.equal(
    formatInferredTitle({ activity: "install", scope: "", title: "BuildKit setup" }),
    "📦 BuildKit setup",
  );
  assert.equal(
    formatInferredTitle({ activity: "fix", scope: "", title: "Fixation tracking" }),
    "🐛 Fixation tracking",
  );
  assert.equal(
    formatInferredTitle({ activity: "explore", scope: "", title: "Review or rewrite?" }),
    "Review or rewrite?",
  );
  assert.throws(() =>
    formatInferredTitle({ activity: "review", scope: "Snapshots", title: "Review" }),
  );
});

test("removes repeated scope from legacy prefix instructions without losing other labels", () => {
  assert.equal(
    formatInferredTitle({
      activity: "explore",
      scope: "Monaco editor plugin",
      title: "[Monaco Editor] Use TextMate rules without TS LSP?",
    }),
    "[Monaco editor plugin] Use TextMate rules without TS LSP?",
  );
  assert.equal(
    formatInferredTitle({
      activity: "fix",
      scope: "GTD + Vimium",
      title: "[GTD] Waiting sort & focus fixes",
    }),
    "🐛 [GTD + Vimium] Waiting sort & focus fixes",
  );
  assert.equal(
    formatInferredTitle({ activity: "plan", scope: "Transport", title: "[RFC] Retry design" }),
    "📝 [Transport] [RFC] Retry design",
  );
  assert.throws(() =>
    formatInferredTitle({ activity: "explore", scope: "Editor", title: "[Editor]" }),
  );
});
