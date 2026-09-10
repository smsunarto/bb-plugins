import { describe, expect, test } from "bun:test";
import { readInferenceResponse } from "@bb-plugins/codex-inference/client";

const sse = (events: unknown[]) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));

describe("readInferenceResponse", () => {
  test("joins the text deltas; the terminal event carries no text", async () => {
    const stream = sse([
      { type: "response.output_text.delta", delta: '{"title":"Fi' },
      { type: "response.output_text.delta", delta: 'nal"}' },
      { type: "response.completed", response: { id: "resp_1" } },
    ]);
    expect(await readInferenceResponse(stream)).toBe('{"title":"Final"}');
  });

  test("rejects a stream without text", async () => {
    const stream = sse([{ type: "response.completed", response: { id: "resp_1" } }]);
    await expect(readInferenceResponse(stream)).rejects.toMatchObject({
      code: "invalid_response",
      message: "Codex response did not include structured output text.",
    });
  });

  test("a failure reported on the terminal event wins over the text", async () => {
    const stream = sse([
      { type: "response.output_text.delta", delta: '{"title":"Half' },
      { type: "response.completed", response: { error: { code: "rate_limit_exceeded" } } },
    ]);
    await expect(readInferenceResponse(stream)).rejects.toMatchObject({ code: "rate_limited" });
  });

  test("maps a streamed failure onto the service error codes", async () => {
    const stream = sse([
      { type: "response.failed", response: { error: { code: "server_error", message: "Boom" } } },
    ]);
    await expect(readInferenceResponse(stream)).rejects.toMatchObject({
      code: "service_unavailable",
      message: "Boom",
    });
  });

  test("stops reading past the size cap", async () => {
    const stream = new Response(`data: {"type":"noise","pad":"${"x".repeat(2_000)}"}\n\n`);
    await expect(readInferenceResponse(stream, 1_000)).rejects.toMatchObject({
      code: "invalid_response",
    });
  });
});
