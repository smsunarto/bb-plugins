import { describe, expect, it, vi } from "vitest";
import type { ApiRequest, ApiResponse } from "../../shared/contracts/api-tunnel.ts";
import { ReviewApiClient } from "../../shared/vendor/review-protocol/src/index.ts";
import { createLiveHub } from "./live-watch.ts";
import { createTunnel, toResponse, tunnelPath } from "./tunnel.ts";

const ORIGIN = "http://127.0.0.1:1";

function tunnelWith(answer: (request: ApiRequest) => ApiResponse | Promise<ApiResponse>) {
  const api = vi.fn(async (request: ApiRequest) => answer(request));
  return {
    api,
    request: createTunnel({
      rpc: { api },
      threadId: "thread-1",
      hub: createLiveHub({ interest: async () => ({}) }),
    }),
  };
}

const ok = (body: string, contentType = "application/json"): ApiResponse => ({
  status: 200,
  contentType,
  encoding: "utf8",
  body,
});

describe("tunnelPath", () => {
  it("strips the origin and the /reviews-api prefix and keeps the query", () => {
    expect(tunnelPath(`${ORIGIN}/reviews-api/abc/file?file=a.ts&side=head`)).toBe(
      "/abc/file?file=a.ts&side=head",
    );
    expect(tunnelPath(`${ORIGIN}/reviews-api?mode=textual`)).toBe("/?mode=textual");
    expect(tunnelPath(`${ORIGIN}/reviews-api/watch`)).toBe("/watch");
    expect(tunnelPath("/reviews-api/commands")).toBe("/commands");
  });
});

describe("toResponse", () => {
  it("decodes base64 bodies to bytes", async () => {
    const response = toResponse({
      status: 200,
      contentType: "image/png",
      encoding: "base64",
      body: btoa("\u0089PNG"),
    });
    expect(response.headers.get("content-type")).toBe("image/png");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("drops the body of null-body statuses", async () => {
    const response = toResponse({
      status: 204,
      contentType: "text/plain",
      encoding: "utf8",
      body: "x",
    });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });
});

describe("createTunnel", () => {
  it("forwards GET and POST with the thread and the JSON body", async () => {
    const tunnel = tunnelWith((request) => ok(JSON.stringify({ echo: request.path })));
    const client = new ReviewApiClient({ serverUrl: ORIGIN, token: "" }, tunnel.request);

    expect(await client.read("/abc/file?file=a.ts")).toEqual({ echo: "/abc/file?file=a.ts" });
    await client.post("/commands", { commandId: "c1" });

    expect(tunnel.api.mock.calls.map(([request]) => request)).toEqual([
      { method: "GET", path: "/abc/file?file=a.ts", threadId: "thread-1" },
      { method: "POST", path: "/commands", body: '{"commandId":"c1"}', threadId: "thread-1" },
    ]);
  });

  it("surfaces engine errors through ReviewApiClient", async () => {
    const tunnel = tunnelWith(() => ({
      status: 404,
      contentType: "application/json",
      encoding: "utf8",
      body: JSON.stringify({ error: "Review not found." }),
    }));
    const client = new ReviewApiClient({ serverUrl: ORIGIN, token: "" }, tunnel.request);
    await expect(client.read("/missing")).rejects.toMatchObject({
      message: "Review not found.",
      status: 404,
    });
  });

  it("answers 405 for methods the engine does not take", async () => {
    const tunnel = tunnelWith(() => ok("{}"));
    const response = await tunnel.request(`${ORIGIN}/reviews-api/abc`, { method: "DELETE" });
    expect(response.status).toBe(405);
    expect(await response.json()).toEqual({
      error: "Whiteboard does not support DELETE requests.",
    });
    expect(tunnel.api).not.toHaveBeenCalled();
  });

  it("replays a whole structural-diff NDJSON body as a stream", async () => {
    const lines = [
      { type: "progress", done: 1, total: 2 },
      { type: "progress", done: 2, total: 2 },
      { type: "result", files: [] },
    ];
    const tunnel = tunnelWith(() =>
      ok(lines.map((line) => `${JSON.stringify(line)}\n`).join(""), "application/x-ndjson"),
    );
    const response = await tunnel.request(`${ORIGIN}/reviews-api/abc/structural-diff?base=a`);
    const seen: unknown[] = [];
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let pending = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += value;
    }
    for (const line of pending.split("\n").filter(Boolean)) seen.push(JSON.parse(line));
    expect(seen).toEqual(lines);
    expect(tunnel.api).toHaveBeenCalledTimes(1);
  });

  it("routes watch paths to a live stream", async () => {
    const tunnel = tunnelWith(() => ok('[{"reviewId":"a"}]\n', "application/x-ndjson"));
    const abort = new AbortController();
    const response = await tunnel.request(`${ORIGIN}/reviews-api/watch`, { signal: abort.signal });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('[{"reviewId":"a"}]\n');
    abort.abort();
    expect((await reader.read()).done).toBe(true);
  });

  it("rejects with the abort reason and drops a late answer", async () => {
    let answer!: (response: ApiResponse) => void;
    const tunnel = tunnelWith(() => new Promise<ApiResponse>((resolve) => (answer = resolve)));
    const abort = new AbortController();
    const pending = tunnel.request(`${ORIGIN}/reviews-api/abc`, { signal: abort.signal });
    await vi.waitFor(() => expect(tunnel.api).toHaveBeenCalled());
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    answer(ok("{}"));
  });
});
