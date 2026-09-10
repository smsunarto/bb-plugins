import { expect, test } from "bun:test";
import { buildRequestBody, readInferenceResponse } from "../src/chatgpt-client.ts";

test("routing sends Luna medium and structured output in a single tool-free request", () => {
  const body = JSON.parse(
    buildRequestBody({
      model: "gpt-5.6-luna",
      reasoningEffort: "medium",
      prompt: "route",
      outputSchema: { type: "object" },
      timeoutMs: 20_000,
    }),
  );
  expect(body).toMatchObject({
    model: "gpt-5.6-luna",
    reasoning: { effort: "medium" },
    store: false,
    stream: true,
  });
  expect(body.input).toHaveLength(1);
  expect(body.tools).toBeUndefined();
  expect(body.text.format).toMatchObject({ type: "json_schema", strict: true });
});

test("GTD's existing requests keep reasoning disabled", () => {
  expect(
    JSON.parse(
      buildRequestBody({
        model: "gpt-5.6-luna",
        prompt: "title",
        outputSchema: {},
        timeoutMs: 5_000,
      }),
    ).reasoning,
  ).toEqual({ effort: "none" });
});

test("a provider failure after partial deltas rejects instead of accepting partial JSON", async () => {
  const response = new Response(
    'data: {"type":"response.output_text.delta","delta":"{}"}\n\ndata: {"type":"response.failed","response":{"error":{"code":"server_error","message":"failed"}}}\n\n',
  );
  await expect(readInferenceResponse(response)).rejects.toThrow("failed");
});
