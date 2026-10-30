import { Effect, Stream } from "effect";
import { describe, expect, test, vi } from "vitest";
import { BoatApiError, canRetry, createBoatClient, type BoatClient } from "./boat-api.ts";

interface Recorded {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(routes: (request: Recorded) => Response | Promise<Response>) {
  const calls: Recorded[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    const request: Recorded = {
      method: init?.method ?? "GET",
      url: new URL(String(input)),
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(request);
    return routes(request);
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

/** Every frame one attach stream sends, in order. */
async function collectFrames(client: BoatClient, processId: number) {
  return Effect.runPromise(
    Stream.runCollect(client.attach("bx_abcdefgh", processId, { stdout: 0, stderr: 0 })),
  );
}

/** A response body that arrives in exactly these byte chunks. */
function chunkedBody(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

const sandbox = (overrides: Record<string, unknown> = {}) => ({
  id: "bx_abcdefgh",
  name: "bb test",
  state: "ready",
  type: "default",
  archiveAfter: "2026-10-29T00:00:00Z",
  hydrated: true,
  ...overrides,
});

describe("createBoatClient", () => {
  const credentials = { apiBase: "https://boat.dev/api/v1/", apiKey: "boat_k" };

  test("creates with a bearer token, an idempotency key and the machine label", async () => {
    const { calls, fetchImpl } = fakeFetch(() =>
      json({ ok: true, sandbox: sandbox({ state: "provisioning" }) }, 202),
    );
    const client = createBoatClient(credentials, fetchImpl);
    const created = await client.create({
      key: "machine-key",
      idempotencyKey: "bb-machine-machine-key-n1",
      name: "bb key",
      type: "large",
      from: "web-stack",
      environment: null,
      ttlSeconds: 3600,
    });
    expect(created.state).toBe("provisioning");
    expect(calls[0]).toMatchObject({
      method: "POST",
      headers: { authorization: "Bearer boat_k", "idempotency-key": "bb-machine-machine-key-n1" },
      body: {
        type: "large",
        ttlSeconds: 3600,
        name: "bb key",
        from: "web-stack",
        labels: { bbMachineKey: "machine-key" },
      },
    });
    expect(calls[0]?.url.toString()).toBe("https://boat.dev/api/v1/sandboxes");
    expect(calls[0]?.body).not.toHaveProperty("environment");
  });

  test("get answers null for 404 and throws a typed error otherwise", async () => {
    const { fetchImpl } = fakeFetch((request) =>
      request.url.pathname.endsWith("/bx_missing1")
        ? json(
            {
              ok: false,
              error: { code: "not_found", message: "no such sandbox" },
              requestId: "req_1",
            },
            404,
          )
        : json({ ok: false, error: { code: "rate_limited", message: "slow down" } }, 429),
    );
    const client = createBoatClient(credentials, fetchImpl);
    await expect(client.get("bx_missing1")).resolves.toBeNull();
    const failure = await client.get("bx_other").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BoatApiError);
    expect(failure).toMatchObject({
      status: 429,
      code: "rate_limited",
      message: "Boat rate_limited: slow down",
    });
  });

  test("listByKey filters by label and follows the cursor", async () => {
    const { calls, fetchImpl } = fakeFetch((request) =>
      request.url.searchParams.get("cursor") === null
        ? json({
            sandboxes: [sandbox({ id: "bx_1" })],
            pageInfo: { nextCursor: "c2", hasMore: true },
          })
        : json({
            sandboxes: [sandbox({ id: "bx_2", state: "archived" })],
            pageInfo: { nextCursor: null, hasMore: false },
          }),
    );
    const client = createBoatClient(credentials, fetchImpl);
    const found = await client.listByKey("machine-key");
    expect(found.map((entry) => entry.id)).toEqual(["bx_1", "bx_2"]);
    expect(calls[0]?.url.searchParams.get("label")).toBe("bbMachineKey=machine-key");
    expect(calls[1]?.url.searchParams.get("cursor")).toBe("c2");
  });

  test("delete confirms the id in a header and tolerates an already deleted sandbox", async () => {
    const { calls, fetchImpl } = fakeFetch((request) =>
      request.url.pathname.endsWith("/bx_gone0000")
        ? json({ ok: false, error: { code: "not_found", message: "gone" } }, 404)
        : json({ ok: true, operation: { id: "bdop_1", status: "pending" } }, 202),
    );
    const client = createBoatClient(credentials, fetchImpl);
    await client.delete("bx_live0000");
    await client.delete("bx_gone0000");
    expect(calls[0]).toMatchObject({
      method: "DELETE",
      headers: { "x-ascii-confirm-delete": "bx_live0000" },
    });
  });

  test("parses Boat's retryable flag and machine message on a failed machine call", async () => {
    const envelope = {
      ok: false,
      type: "sandbox.error",
      status: 502,
      code: "sandbox_direct_failed",
      message: "sandbox_restoring",
      error: {
        code: "sandbox_direct_failed",
        status: 502,
        details: { retryable: true, message: "sandbox_restoring" },
      },
    };
    const { fetchImpl } = fakeFetch(() => json(envelope, 502));
    const client = createBoatClient(credentials, fetchImpl);
    const failure = await client
      .writeFile("bx_1", "/tmp/x", "", "utf8", new AbortController().signal)
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(BoatApiError);
    const typed = failure as BoatApiError;
    expect(typed).toMatchObject({
      status: 502,
      code: "sandbox_direct_failed",
      detail: "sandbox_restoring",
      retryable: true,
    });
    expect(canRetry(typed, "file")).toBe(true);
    expect(canRetry(typed, "command")).toBe(true);
    const ran = new BoatApiError(502, "sandbox_direct_failed", "x", null, "agent timeout", true);
    expect(canRetry(ran, "file")).toBe(true);
    expect(canRetry(ran, "command")).toBe(false);
    expect(canRetry(new BoatApiError(409, "sandbox_starting", "x", null), "command")).toBe(true);
    expect(canRetry(new BoatApiError(503, "no_ready_machine", "x", null), "idempotent")).toBe(true);
    expect(canRetry(new BoatApiError(409, "machine_not_running", "x", null), "command")).toBe(
      false,
    );
    expect(canRetry(new Error("socket"), "idempotent")).toBe(false);
  });

  test("account pins the account by its email when /me has no id", async () => {
    const { fetchImpl } = fakeFetch((request) =>
      request.url.pathname.endsWith("/me")
        ? json({ ok: true, user: { login: "octocat", email: "octocat@example.com" } })
        : json({ ok: true }),
    );
    const client = createBoatClient(credentials, fetchImpl);
    const account = await client.account();
    expect(account.identity).toMatch(/^[a-f0-9]{64}$/);
    expect(account.login).toBe("octocat");
  });

  test("account hashes the user id and reads the limits", async () => {
    const { fetchImpl } = fakeFetch((request) =>
      request.url.pathname.endsWith("/me")
        ? json({ ok: true, user: { id: "user_1", login: "scott" } })
        : json({
            ok: true,
            activeSandboxes: 2,
            maxActiveSandboxes: 100,
            machineTypes: [{ type: "xlarge", available: false, reason: "plan" }],
          }),
    );
    const client = createBoatClient(credentials, fetchImpl);
    const account = await client.account();
    expect(account).toMatchObject({ login: "scott", activeSandboxes: 2, maxActiveSandboxes: 100 });
    expect(account.identity).toMatch(/^[a-f0-9]{64}$/);
    expect(account.identity).not.toContain("user_1");
    await expect(client.machineTypes()).resolves.toEqual([
      { type: "xlarge", available: false, reason: "plan" },
    ]);
  });

  test("attach yields parsed NDJSON frames", async () => {
    const lines = [
      { type: "attached", processId: 7, stdoutOffset: 0, stderrOffset: 0 },
      { type: "stdout", data: "hello\n", nextOffset: 6 },
      { type: "heartbeat" },
      {
        type: "exit",
        status: "exited",
        exitCode: 0,
        signal: null,
        stdoutOffset: 6,
        stderrOffset: 0,
      },
    ];
    const { calls, fetchImpl } = fakeFetch(
      () => new Response(lines.map((line) => JSON.stringify(line)).join("\n") + "\n"),
    );
    const client = createBoatClient(credentials, fetchImpl);
    const frames = (await collectFrames(client, 7)).map((frame) => frame.type);
    expect(frames).toEqual(["attached", "stdout", "heartbeat", "exit"]);
    expect(calls[0]?.url.search).toBe("?stdoutOffset=0&stderrOffset=0");
  });

  test("attach reads frames split across chunks, multi-byte text, blank lines and a last line without a newline", async () => {
    const encoder = new TextEncoder();
    const text = [
      JSON.stringify({ type: "attached" }),
      "",
      JSON.stringify({ type: "stdout", data: "caf\u00e9", nextOffset: 5 }),
      JSON.stringify({ type: "exit", status: "exited", exitCode: 0, signal: null }),
    ].join("\n");
    const bytes = encoder.encode(text);
    // Split inside the first frame and inside the two-byte "é".
    const accent = bytes.indexOf(0xc3);
    const { fetchImpl } = fakeFetch(
      () =>
        new Response(
          chunkedBody([bytes.slice(0, 7), bytes.slice(7, accent + 1), bytes.slice(accent + 1)]),
        ),
    );
    const client = createBoatClient(credentials, fetchImpl);
    await expect(collectFrames(client, 7)).resolves.toEqual([
      { type: "attached" },
      { type: "stdout", data: "caf\u00e9", nextOffset: 5 },
      { type: "exit", status: "exited", exitCode: 0, signal: null },
    ]);
  });

  test("attach fails with Boat's error when the stream is refused", async () => {
    const { fetchImpl } = fakeFetch(() =>
      json({ ok: false, error: { code: "process_not_found", message: "no such process" } }, 404),
    );
    const client = createBoatClient(credentials, fetchImpl);
    const failure = await collectFrames(client, 7).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BoatApiError);
    expect(failure).toMatchObject({
      status: 404,
      message: "Boat process_not_found: no such process",
    });
  });
});
