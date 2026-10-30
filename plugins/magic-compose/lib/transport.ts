// One warm HTTP/2 connection per gateway, shared by every Jev call.
//
// A routing decision is several small requests fired together after the user
// has been idle for a while. With fetch, each of those opens a new connection,
// because Node drops idle ones after four seconds. A new connection is the
// worst place to lose a packet: TCP has no round-trip estimate yet, so it waits
// a full second before resending, and that second lands on the dispatch. One
// long-lived connection avoids the handshakes, keeps its congestion window
// open, recovers from loss in a fraction of the time, and carries the parallel
// questions side by side.
import http2 from "node:http2";
import { Context, Deferred, Effect, Layer, RcMap, type Scope } from "effect";

/** How long a connection is kept open after it was last used or warmed. */
const KEEP_HOT_MS = 3 * 60_000;
/** Pings keep NATs and the gateway from dropping the idle connection. */
const PING_EVERY_MS = 15_000;
const CONNECT_TIMEOUT_MS = 5_000;

export interface TransportResponse {
  status: number;
  body: string;
}

interface HotSession {
  session: http2.ClientHttp2Session;
  /** Settles once the connection opens, or fails to. */
  ready: Deferred.Deferred<void, Error>;
  /** Whether a request has completed on it. The first one on a connection is slow. */
  primed: boolean;
}

/**
 * A connection to `origin` that lives as long as the scope. Opening it never
 * fails; `ready` does, so a connection that could not open is not kept.
 */
const connect = Effect.fnUntraced(function* (origin: string) {
  const session = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const session = http2.connect(origin);
      // The connection must never keep the BB server alive on its own.
      session.unref();
      return session;
    }),
    (session) => Effect.sync(() => session.destroy()),
  );
  const hot: HotSession = { session, ready: Deferred.makeUnsafe(), primed: false };
  session.once("connect", () => Deferred.doneUnsafe(hot.ready, Effect.void));
  // A connection that breaks or is told to go away is replaced by the next request.
  session.on("error", (error) => Deferred.doneUnsafe(hot.ready, Effect.fail(error)));
  session.on("goaway", () => session.destroy());
  yield* Deferred.await(hot.ready).pipe(
    Effect.timeoutOrElse({
      duration: CONNECT_TIMEOUT_MS,
      orElse: () =>
        Effect.sync(() => {
          Deferred.doneUnsafe(
            hot.ready,
            Effect.fail(new Error(`Timed out connecting to ${origin}`)),
          );
          session.destroy();
        }),
    }),
    Effect.ignore,
    Effect.forkScoped,
  );
  yield* Effect.sync(() => ping(session)).pipe(
    Effect.delay(PING_EVERY_MS),
    Effect.forever,
    Effect.forkScoped,
  );
  return hot;
});

function ping(session: http2.ClientHttp2Session): void {
  if (session.destroyed || session.closed) return;
  try {
    session.ping(() => {});
  } catch {
    session.destroy();
  }
}

function request(
  hot: HotSession,
  target: URL,
  headers: Record<string, string>,
  body: string,
): Effect.Effect<TransportResponse, Error> {
  return Effect.callback<TransportResponse, Error>((resume) => {
    let stream: http2.ClientHttp2Stream;
    try {
      stream = hot.session.request({
        ...Object.fromEntries(
          Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
        ),
        ":method": "POST",
        ":path": `${target.pathname}${target.search}`,
        "content-length": String(Buffer.byteLength(body)),
      });
    } catch (error) {
      resume(Effect.fail(error as Error));
      return;
    }
    let status = 0;
    const chunks: Buffer[] = [];
    stream.on("response", (responseHeaders) => {
      status = Number(responseHeaders[":status"] ?? 0);
    });
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => {
      hot.primed = true;
      resume(Effect.succeed({ status, body: Buffer.concat(chunks).toString("utf8") }));
    });
    stream.on("error", (error) => {
      // A broken stream usually means a broken connection; start fresh next time.
      hot.session.destroy();
      resume(Effect.fail(error));
    });
    stream.end(body);
    return Effect.sync(() => stream.close(http2.constants.NGHTTP2_CANCEL));
  });
}

export class JevTransport extends Context.Service<
  JevTransport,
  {
    /**
     * Open the connection to `url`'s origin ahead of need. The first request on
     * a new connection takes a second or more even after the handshake, so when
     * the connection has not carried one yet, `prime` is run to get that over
     * with. Never fails.
     */
    warm<E, R>(url: string, prime: Effect.Effect<unknown, E, R>): Effect.Effect<void, never, R>;
    post(
      url: string,
      headers: Record<string, string>,
      body: string,
    ): Effect.Effect<TransportResponse, Error>;
  }
>()("magic-compose/JevTransport") {
  /** Connections close once idle for `KEEP_HOT_MS`, and all of them with the layer. */
  static readonly layer = Layer.effect(
    JevTransport,
    Effect.gen(function* () {
      const sessions = yield* RcMap.make({ lookup: connect, idleTimeToLive: KEEP_HOT_MS });

      /** The connection to `origin` for the current scope, replacing one that has closed. */
      const acquire = (origin: string): Effect.Effect<HotSession, never, Scope.Scope> =>
        Effect.flatMap(RcMap.get(sessions, origin), (hot) =>
          hot.session.closed || hot.session.destroyed
            ? Effect.andThen(RcMap.invalidate(sessions, origin), acquire(origin))
            : Effect.succeed(hot),
        );

      return JevTransport.of({
        warm: (url, prime) =>
          Effect.gen(function* () {
            const hot = yield* acquire(new URL(url).origin);
            yield* Deferred.await(hot.ready);
            if (!hot.primed) yield* prime;
          }).pipe(
            Effect.scoped,
            // The real request will surface the problem.
            Effect.ignore,
          ),
        post: (url, headers, body) =>
          Effect.gen(function* () {
            const target = new URL(url);
            const hot = yield* acquire(target.origin);
            yield* Deferred.await(hot.ready);
            return yield* request(hot, target, headers, body);
          }).pipe(Effect.scoped),
      });
    }),
  );
}
