import assert from "node:assert/strict";
import { describe, test } from "bun:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  completeWithModelFallback,
  createThreadTitleInference,
  readTitleReply,
  type TitleInferenceAttempt,
} from "../thread-title-inference.ts";

const PRIMARY_HOST_BB = {
  sdk: { system: { config: async () => ({ primaryHostId: "host-primary" }) } },
  log: { info: () => {} },
} as unknown as BbPluginApi;

describe("thread title inference", () => {
  test("sends the plain prompt to GPT-6-Luna on the primary host", async () => {
    const calls: Array<{ method: string; input: unknown; options: unknown }> = [];
    const title = await createThreadTitleInference(PRIMARY_HOST_BB, {
      call: async (method, input, options) => {
        calls.push({ method, input, options });
        return { ok: true, text: "Name threads" };
      },
    }).complete({ environmentId: null, prompt: "Generate a title", allowKeep: false });

    assert.equal(title, "Name threads");
    assert.deepEqual(calls, [
      {
        method: "codex.ai.complete",
        input: { model: "gpt-6-luna", prompt: "Generate a title", timeoutMs: 5_000 },
        options: { hostId: "host-primary", timeoutMs: 6_000 },
      },
    ]);
  });

  test("a KEEP reply keeps the title only when the prompt allowed it", async () => {
    const inference = createThreadTitleInference(PRIMARY_HOST_BB, {
      call: async () => ({ ok: true, text: "KEEP" }),
    });
    assert.equal(
      await inference.complete({ environmentId: null, prompt: "Review", allowKeep: true }),
      null,
    );
    await assert.rejects(
      inference.complete({ environmentId: null, prompt: "Generate", allowKeep: false }),
      /kept the title when a new name was requested/u,
    );
  });

  test("replaces bb's AI-services hint in a Cloudflare failure", async () => {
    await assert.rejects(
      createThreadTitleInference(PRIMARY_HOST_BB, {
        call: async () => ({
          ok: false,
          code: "request_failed",
          message:
            "Codex inference request failed with HTTP 403: chatgpt.com answered with a Cloudflare challenge that bb cannot solve. Retry, or choose another service in Settings → AI services.",
        }),
      }).complete({ environmentId: null, prompt: "Generate", allowKeep: false }),
      {
        message:
          "Codex inference request failed with HTTP 403: chatgpt.com answered with a Cloudflare challenge that bb cannot solve. Retry, or log in to Codex with an OpenAI API key so naming requests go to api.openai.com instead.",
      },
    );
  });
});

describe("completeWithModelFallback", () => {
  test("tries GPT-5.6-Luna after a retryable failure and records each attempt", async () => {
    const attempts: TitleInferenceAttempt[] = [];
    const text = await completeWithModelFallback({
      onAttempt: (attempt) => attempts.push(attempt),
      complete: async (model) =>
        model === "gpt-6-luna"
          ? { ok: false, code: "rate_limited", message: "slow down" }
          : { ok: true, text: "Fallback title" },
    });

    assert.equal(text, "Fallback title");
    assert.deepEqual(
      attempts.map(({ model, attempt, outcome }) => [model, attempt, outcome]),
      [
        ["gpt-6-luna", 0, "rate_limited"],
        ["gpt-5.6-luna", 1, "success"],
      ],
    );
  });

  test("retries a cold-start timeout with the next model", async () => {
    const models: string[] = [];
    const text = await completeWithModelFallback({
      complete: async (model) => {
        models.push(model);
        return models.length === 1
          ? { ok: false, code: "timeout", message: "timed out" }
          : { ok: true, text: "Named" };
      },
    });
    assert.equal(text, "Named");
    assert.deepEqual(models, ["gpt-6-luna", "gpt-5.6-luna"]);
  });

  test("does not retry a login or request failure", async () => {
    for (const code of ["auth_required", "request_failed"] as const) {
      const models: string[] = [];
      await assert.rejects(
        completeWithModelFallback({
          complete: async (model) => {
            models.push(model);
            return { ok: false, code, message: `failed: ${code}` };
          },
        }),
        { message: `failed: ${code}` },
      );
      assert.deepEqual(models, ["gpt-6-luna"]);
    }
  });

  test("observer errors cannot fail a valid reply", async () => {
    assert.equal(
      await completeWithModelFallback({
        onAttempt: () => {
          throw new Error("logger");
        },
        complete: async () => ({ ok: true, text: "Named" }),
      }),
      "Named",
    );
  });
});

describe("readTitleReply", () => {
  test("returns project formatting untouched", () => {
    for (const title of [
      "Fix sorting",
      "[Billing] Fix sorting",
      "[RFC] Retry design",
      "iOS setup",
    ]) {
      assert.equal(readTitleReply(title, false), title);
    }
  });

  test("strips labels, wrapping quotes, fences, and trailing lines", () => {
    assert.equal(readTitleReply('Title: "Fix sorting"', false), "Fix sorting");
    assert.equal(readTitleReply("```\n**[GTD] Shimmer names**\n```", false), "[GTD] Shimmer names");
    assert.equal(readTitleReply("\n  “Retry design”  \nBecause the task", false), "Retry design");
    assert.equal(
      readTitleReply("<think>hmm</think>\nKeep “quotes” inside", false),
      "Keep “quotes” inside",
    );
  });

  test("reads KEEP loosely and rejects an empty reply", () => {
    for (const reply of ["KEEP", "keep", " `KEEP.` ", "Title: KEEP"]) {
      assert.equal(readTitleReply(reply, true), null, reply);
    }
    assert.throws(() => readTitleReply(" \n``` \n", false), /returned no title/u);
  });
});
