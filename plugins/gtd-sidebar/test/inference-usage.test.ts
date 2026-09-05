import { describe, expect, test } from "bun:test";
import { readInferenceResponse } from "../host/inference/chatgpt-client.ts";
import { gtdSidebarHostContract } from "../lib/host-contract.ts";

const args = () => ({
  deadline: { expiresAt: performance.now() + 5_000, timeoutMs: 5_000 },
  maxBytes: 32_000,
  maxEventChars: 16_000,
});

describe("inference stream usage", () => {
  test("retains completed usage without duplicating streamed text or reasoning tokens", async () => {
    const stream = [
      { type: "response.output_text.delta", delta: '{"title":"Partial"}' },
      {
        type: "response.completed",
        response: {
          output: [{ content: [{ type: "output_text", text: '{"title":"Final"}' }] }],
          usage: {
            input_tokens: 200,
            output_tokens: 30,
            input_tokens_details: { cached_tokens: 100 },
            output_tokens_details: { reasoning_tokens: 20 },
          },
        },
      },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join("");
    const result = await readInferenceResponse(new Response(stream), args());
    expect(result).toEqual({
      text: '{"title":"Final"}',
      usage: { inputTokens: 200, outputTokens: 30, cachedInputTokens: 100, reasoningTokens: 20 },
    });
    expect(
      gtdSidebarHostContract["ai.inference.complete"].output.parse({
        ok: true,
        model: "test",
        value: { title: "Final" },
        usage: result.usage,
      }).ok,
    ).toBe(true);
  });

  test.each([undefined, { input_tokens: -1, output_tokens: 3 }, { input_tokens: 12 }])(
    "preserves valid output with unknown usage %j",
    async (usage) => {
      const event = {
        type: "response.done",
        response: {
          output: [{ content: [{ type: "output_text", text: '{"title":"Valid"}' }] }],
          usage,
        },
      };
      expect(
        await readInferenceResponse(new Response(`data: ${JSON.stringify(event)}\n\n`), args()),
      ).toEqual({ text: '{"title":"Valid"}' });
    },
  );

  test("completion usage also accompanies delta-only output", async () => {
    const events = [
      { type: "response.output_text.delta", delta: '{"title":"Delta"}' },
      { type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 6 } } },
    ];
    const response = new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    );
    expect(await readInferenceResponse(response, args())).toEqual({
      text: '{"title":"Delta"}',
      usage: { inputTokens: 5, outputTokens: 6 },
    });
  });
});
