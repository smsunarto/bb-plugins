import http2 from "node:http2";
import net from "node:net";
import { makePluginRuntime } from "@bb-plugins/effect-bridge";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JevTransport } from "./transport";

/** The transport as its callers drive it: through the plugin's runtime, until it is disposed. */
async function openTransport() {
  const disposers: (() => void | Promise<void>)[] = [];
  const quiet = () => {};
  const runtime = await makePluginRuntime(
    {
      log: { debug: quiet, info: quiet, warn: quiet, error: quiet },
      onDispose: (dispose) => void disposers.push(dispose),
    },
    JevTransport.layer,
  );
  return {
    post: (
      url: string,
      body: string,
      signal?: AbortSignal,
      headers: Record<string, string> = { "Content-Type": "application/json" },
    ) =>
      runtime.run(
        JevTransport.use((transport) => transport.post(url, headers, body)),
        signal,
      ),
    warm: (url: string, prime: () => Promise<unknown>) =>
      runtime.run(
        JevTransport.use((transport) =>
          transport.warm(url, Effect.tryPromise({ try: prime, catch: (error) => error })),
        ),
      ),
    close: async () => {
      for (const dispose of disposers.splice(0)) await dispose();
    },
  };
}

/** Real event-loop turns, which fake timers leave alone, until `done` holds. */
async function until(done: () => boolean, turns = 2_000): Promise<void> {
  for (let turn = 0; turn < turns && !done(); turn++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Advance fake time in steps, letting sockets and fibers run between them. */
async function advance(ms: number, step = 5_000): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    await vi.advanceTimersByTimeAsync(Math.min(step, ms - elapsed));
    await until(() => false, 20);
  }
}

function settled<T>(promise: Promise<T>) {
  const state: { done: boolean; value?: T; error?: unknown } = { done: false };
  promise.then(
    (value) => Object.assign(state, { done: true, value }),
    (error: unknown) => Object.assign(state, { done: true, error }),
  );
  return state;
}

/** A cleartext HTTP/2 server standing in for a gateway. */
async function startGateway(
  onStream: (stream: http2.ServerHttp2Stream, body: string) => void = (stream, body) => {
    stream.respond({ ":status": 200 });
    stream.end(`echo:${body}`);
  },
) {
  const server = http2.createServer();
  const sessions: http2.ServerHttp2Session[] = [];
  const closedSessions: http2.ServerHttp2Session[] = [];
  const streams: http2.ServerHttp2Stream[] = [];
  const requests: http2.IncomingHttpHeaders[] = [];
  let pings = 0;
  server.on("session", (session) => {
    sessions.push(session);
    session.on("ping", () => pings++);
    session.on("close", () => closedSessions.push(session));
  });
  server.on("stream", (stream, headers) => {
    streams.push(stream);
    requests.push(headers);
    // A reset this server sends is reported here too; the client side is under test.
    stream.on("error", () => {});
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => onStream(stream, Buffer.concat(chunks).toString("utf8")));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v4/ai/evaluation-model`,
    sessions,
    closedSessions,
    streams,
    requests,
    pings: () => pings,
    async stop() {
      for (const session of sessions) session.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Accepts connections and never answers, so a TLS handshake never completes. */
async function startSilentServer() {
  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => sockets.push(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    origin: `https://127.0.0.1:${port}`,
    connections: () => sockets.length,
    async stop() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const gateway = await startGateway();
  const transport = await openTransport();
  cleanups.push(gateway.stop, transport.close);
  return { gateway, transport };
}

function useNarrowFakeTimers() {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
}

describe("JevTransport", () => {
  it("posts over one shared connection per origin", async () => {
    const { gateway, transport } = await setup();

    const first = await transport.post(gateway.url, "one");
    const [second, third] = await Promise.all([
      transport.post(gateway.url, "two"),
      transport.post(`${gateway.url}?again=1`, "three"),
    ]);

    expect(first).toEqual({ status: 200, body: "echo:one" });
    expect(second).toEqual({ status: 200, body: "echo:two" });
    expect(third).toEqual({ status: 200, body: "echo:three" });
    expect(gateway.sessions).toHaveLength(1);
  });

  it("sends the path, method, length, and lower-cased headers", async () => {
    const gateway = await startGateway((stream) => {
      stream.respond({ ":status": 201 });
      stream.end();
    });
    const transport = await openTransport();
    cleanups.push(gateway.stop, transport.close);

    const response = await transport.post(`${gateway.url}?x=1`, "héllo", undefined, {
      Authorization: "Bearer k",
      "AI-Model-Id": "jev",
    });

    expect(response).toEqual({ status: 201, body: "" });
    expect(gateway.requests[0]).toMatchObject({
      ":method": "POST",
      ":path": "/v4/ai/evaluation-model?x=1",
      "content-length": "6",
      authorization: "Bearer k",
      "ai-model-id": "jev",
    });
  });

  it("keeps an idle connection open and pinged for three minutes, then closes it", async () => {
    const { gateway, transport } = await setup();
    useNarrowFakeTimers();

    await transport.post(gateway.url, "one");
    await advance(15_000);
    expect(gateway.pings()).toBeGreaterThanOrEqual(1);

    await advance(150_000);
    expect(gateway.closedSessions).toHaveLength(0);

    await advance(45_000);
    await until(() => gateway.closedSessions.length > 0);
    expect(gateway.closedSessions).toHaveLength(1);

    await transport.post(gateway.url, "two");
    expect(gateway.sessions).toHaveLength(2);
  });

  it("gives up on a connection that does not open within five seconds, and tries afresh next time", async () => {
    const silent = await startSilentServer();
    const transport = await openTransport();
    cleanups.push(silent.stop, transport.close);
    useNarrowFakeTimers();

    const attempt = settled(transport.post(`${silent.origin}/x`, "one"));
    await until(() => silent.connections() === 1);
    await advance(4_000, 1_000);
    expect(attempt.done).toBe(false);
    await advance(1_000, 1_000);
    await until(() => attempt.done);
    expect((attempt.error as Error).message).toBe(`Timed out connecting to ${silent.origin}`);

    void transport.post(`${silent.origin}/x`, "two").catch(() => {});
    await until(() => silent.connections() === 2);
    expect(silent.connections()).toBe(2);
  });

  it("stops waiting for a connection as soon as the caller aborts", async () => {
    const silent = await startSilentServer();
    const transport = await openTransport();
    cleanups.push(silent.stop, transport.close);
    useNarrowFakeTimers();

    const controller = new AbortController();
    const reason = new Error("caller left");
    const attempt = settled(transport.post(`${silent.origin}/x`, "one", controller.signal));
    await until(() => silent.connections() === 1);
    controller.abort(reason);
    await until(() => attempt.done);

    expect(attempt.done).toBe(true);
    expect(attempt.error).toBe(reason);
  });

  it("cancels the request when the caller aborts mid-flight", async () => {
    const gateway = await startGateway(() => {
      // Never answers.
    });
    const transport = await openTransport();
    cleanups.push(gateway.stop, transport.close);

    const controller = new AbortController();
    const reason = new Error("caller left");
    const attempt = settled(transport.post(gateway.url, "one", controller.signal));
    await until(() => gateway.streams.length === 1);
    const stream = gateway.streams[0];
    const closedWith = new Promise<number>((resolve) =>
      stream?.on("close", () => resolve(stream.rstCode)),
    );
    controller.abort(reason);
    await until(() => attempt.done);

    expect(attempt.error).toBe(reason);
    expect(await closedWith).toBe(http2.constants.NGHTTP2_CANCEL);
  });

  it("starts a new connection after a stream breaks or the gateway sends GOAWAY", async () => {
    let breakNext = false;
    const gateway = await startGateway((stream, body) => {
      if (breakNext) {
        breakNext = false;
        stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
        return;
      }
      stream.respond({ ":status": 200 });
      stream.end(`echo:${body}`);
    });
    const transport = await openTransport();
    cleanups.push(gateway.stop, transport.close);

    await transport.post(gateway.url, "one");
    breakNext = true;
    await expect(transport.post(gateway.url, "two")).rejects.toThrow();
    expect(await transport.post(gateway.url, "three")).toEqual({
      status: 200,
      body: "echo:three",
    });
    expect(gateway.sessions).toHaveLength(2);

    gateway.sessions[1]?.goaway();
    await until(() => gateway.closedSessions.includes(gateway.sessions[1]!));
    expect(await transport.post(gateway.url, "four")).toEqual({ status: 200, body: "echo:four" });
    expect(gateway.sessions).toHaveLength(3);
  });

  it("warms a connection ahead of need and primes it only until a request has completed", async () => {
    const { gateway, transport } = await setup();
    let primes = 0;
    const prime = () => {
      primes++;
      return transport.post(gateway.url, "prime");
    };

    await transport.warm(gateway.url, prime);
    await transport.warm(gateway.url, prime);

    expect(primes).toBe(1);
    expect(gateway.sessions).toHaveLength(1);
  });

  it("warming never throws, whether the connection or the prime fails", async () => {
    const { gateway, transport } = await setup();
    await expect(
      transport.warm(gateway.url, () => Promise.reject(new Error("prime failed"))),
    ).resolves.toBeUndefined();

    const silent = await startSilentServer();
    cleanups.push(silent.stop);
    useNarrowFakeTimers();
    let primed = false;
    const warming = settled(
      transport.warm(`${silent.origin}/x`, async () => {
        primed = true;
      }),
    );
    await until(() => silent.connections() === 1);
    await advance(5_000, 1_000);
    await until(() => warming.done);
    expect(warming).toMatchObject({ done: true, value: undefined });
    expect(primed).toBe(false);
  });

  it("closes every connection when it is closed", async () => {
    const { gateway, transport } = await setup();
    await transport.post(gateway.url, "one");

    await transport.close();
    await until(() => gateway.closedSessions.length === 1);

    expect(gateway.closedSessions).toHaveLength(1);
  });
});
