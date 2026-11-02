import { afterEach, describe, expect, test } from "bun:test";
import { postTrace } from "./neatlogs.ts";
import type { NeatlogsConfig } from "./settings.ts";
import type { NeatlogsSpan } from "./turn-trace.ts";

const config: NeatlogsConfig = {
  apiKey: "test-key",
  traceUrl: "https://ingest.example/v1/trace",
  contentMode: "full",
};
const trace: NeatlogsSpan = {
  name: "bb-agent-turn",
  kind: "WORKFLOW",
  start: "2026-11-02T00:00:00.000Z",
  end: "2026-11-02T00:00:01.000Z",
  status: "OK",
};
const realFetch = globalThis.fetch;

function respond(status: number, body: string, contentType: string) {
  globalThis.fetch = (async () =>
    new Response(body, { status, headers: { "content-type": contentType } })) as never;
  return postTrace(config, trace, new AbortController().signal);
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("postTrace", () => {
  test("tells the ingest firewall's HTML 403 apart from a refused key", async () => {
    const html = "<html><head><title>403 Forbidden</title></head></html>";
    expect(await respond(403, html, "text/html")).toEqual({ kind: "blocked" });
    expect(await respond(403, '{"error":"Forbidden"}', "application/json")).toEqual({
      kind: "refused",
      status: 403,
    });
    expect(await respond(401, '{"error":"Invalid API key"}', "application/json")).toEqual({
      kind: "refused",
      status: 401,
    });
  });

  test("maps the remaining statuses", async () => {
    expect(await respond(400, '{"error":"Validation error"}', "application/json")).toEqual({
      kind: "rejected",
      status: 400,
    });
    expect(await respond(429, "", "text/plain")).toEqual({ kind: "retry", reason: "HTTP 429" });
    expect(
      await respond(200, '{"success":true,"trace_id":"abc","spans":3}', "application/json"),
    ).toEqual({ kind: "exported", traceId: "abc", spans: 3 });
  });
});
