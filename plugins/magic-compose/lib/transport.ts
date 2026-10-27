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
  ready: Promise<void>;
  lastUsedAt: number;
  /** Whether a request has completed on it. The first one on a connection is slow. */
  primed: boolean;
}

export class JevTransport {
  private readonly sessions = new Map<string, HotSession>();
  private timer: NodeJS.Timeout | null = null;

  /**
   * Open the connection to `url`'s origin ahead of need. The first request on
   * a new connection takes a second or more even after the handshake, so when
   * the connection has not carried one yet, `prime` is run to get that over
   * with. Never throws.
   */
  async warm(url: string, prime: () => Promise<unknown>): Promise<void> {
    try {
      const hot = this.acquire(new URL(url).origin);
      await hot.ready;
      if (!hot.primed) await prime();
    } catch {
      // The real request will surface the problem.
    }
  }

  async post(
    url: string,
    headers: Record<string, string>,
    body: string,
    signal: AbortSignal,
  ): Promise<TransportResponse> {
    const target = new URL(url);
    const hot = this.acquire(target.origin);
    await hot.ready;
    hot.lastUsedAt = Date.now();

    return new Promise<TransportResponse>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason ?? new Error("aborted"));
        return;
      }
      const stream = hot.session.request({
        ...Object.fromEntries(
          Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
        ),
        ":method": "POST",
        ":path": `${target.pathname}${target.search}`,
        "content-length": String(Buffer.byteLength(body)),
      });
      const onAbort = () => {
        stream.close(http2.constants.NGHTTP2_CANCEL);
        reject(signal.reason ?? new Error("aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      let status = 0;
      const chunks: Buffer[] = [];
      stream.on("response", (responseHeaders) => {
        status = Number(responseHeaders[":status"] ?? 0);
      });
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        signal.removeEventListener("abort", onAbort);
        hot.lastUsedAt = Date.now();
        hot.primed = true;
        resolve({ status, body: Buffer.concat(chunks).toString("utf8") });
      });
      stream.on("error", (error) => {
        signal.removeEventListener("abort", onAbort);
        // A broken stream usually means a broken connection; start fresh next time.
        this.drop(target.origin, hot);
        reject(error);
      });
      stream.end(body);
    });
  }

  /** Close every connection. Call when the plugin is disposed. */
  close(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    for (const [origin, hot] of this.sessions) this.drop(origin, hot);
  }

  private acquire(origin: string): HotSession {
    const existing = this.sessions.get(origin);
    if (existing !== undefined && !existing.session.closed && !existing.session.destroyed) {
      existing.lastUsedAt = Date.now();
      return existing;
    }

    const session = http2.connect(origin);
    // The connection must never keep the BB server alive on its own.
    session.unref();
    const hot: HotSession = {
      session,
      primed: false,
      lastUsedAt: Date.now(),
      ready: new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`Timed out connecting to ${origin}`));
          this.drop(origin, hot);
        }, CONNECT_TIMEOUT_MS);
        session.once("connect", () => {
          clearTimeout(timeout);
          resolve();
        });
        session.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      }),
    };
    // Rejections are reported to whoever awaits `ready`; nobody may be yet.
    hot.ready.catch(() => {});
    const forget = () => this.drop(origin, hot);
    session.on("error", forget);
    session.on("close", forget);
    session.on("goaway", forget);
    this.sessions.set(origin, hot);
    this.schedule();
    return hot;
  }

  private drop(origin: string, hot: HotSession): void {
    if (this.sessions.get(origin) === hot) this.sessions.delete(origin);
    if (!hot.session.destroyed) hot.session.destroy();
  }

  private schedule(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      for (const [origin, hot] of this.sessions) {
        if (Date.now() - hot.lastUsedAt > KEEP_HOT_MS) this.drop(origin, hot);
        else if (!hot.session.destroyed && !hot.session.closed) {
          try {
            hot.session.ping(() => {});
          } catch {
            this.drop(origin, hot);
          }
        }
      }
      if (this.sessions.size === 0 && this.timer !== null) {
        clearInterval(this.timer);
        this.timer = null;
      }
    }, PING_EVERY_MS);
    this.timer.unref();
  }
}

/** Shared by every Jev call in this plugin instance. */
export const jevTransport = new JevTransport();
