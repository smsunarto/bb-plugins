import { type ApiResponse, WATCH_HEARTBEAT_MS } from "../../shared/contracts/api-tunnel.ts";
import type { ChangedPayload } from "../../shared/contracts/channels.ts";
import type { WhiteboardRpcClient } from "../rpc.ts";

/**
 * NDJSON watch streams rebuilt from `whiteboard:changed` invalidations
 * (design §1.3). Upstream `watch()` sends a full `read()` per line, so one
 * tunnel call per invalidation yields the same lines:
 *
 *   tunnel GET /watch...  -> line 1
 *   whiteboard:changed    -> (matches this stream) -> tunnel GET -> line N
 *
 * A multi-subscription stream re-reads only the subscriptions an
 * invalidation matches, as upstream re-reads only its dirty entries. At most
 * one refetch is in flight per stream. Invalidations that land meanwhile
 * collapse into one follow-up. A realtime reconnect re-reads every live
 * stream in full, and so does a slow safety refetch. The hub, not the
 * streams, renews the server's worktree interest lease.
 */

type Listener = (change: ChangedPayload | "reconnected") => void;
type InterestRpc = Pick<WhiteboardRpcClient, "interest">;

/** Realtime fan-in for one mount. The panel feeds it from `useRealtime`. */
export interface LiveHub {
  invalidate(change: ChangedPayload): void;
  /** The realtime connection came back; signals may have been missed. */
  reconnected(): void;
  /**
   * Listen for changes. While anything listens, the hub renews the server's
   * worktree interest lease every `WATCH_HEARTBEAT_MS`, and once when the
   * document becomes visible again. A hidden document renews nothing, so the
   * lease lapses after `UI_INTEREST_TTL_MS`.
   */
  subscribe(listener: Listener): () => void;
}

const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

export function createLiveHub(rpc: InterestRpc): LiveHub {
  const listeners = new Set<Listener>();
  const fire = (change: ChangedPayload | "reconnected") => {
    for (const listener of Array.from(listeners)) listener(change);
  };
  const renew = () => {
    // A failed renewal waits for the next beat; the lease outlives two misses.
    rpc.interest().catch(() => {});
  };
  const renewIfVisible = () => {
    if (!hidden()) renew();
  };
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const start = () => {
    heartbeat = setInterval(renewIfVisible, WATCH_HEARTBEAT_MS);
    if (typeof document !== "undefined")
      document.addEventListener("visibilitychange", renewIfVisible);
  };
  const stop = () => {
    clearInterval(heartbeat);
    if (typeof document !== "undefined")
      document.removeEventListener("visibilitychange", renewIfVisible);
  };
  return {
    invalidate: fire,
    reconnected: () => fire("reconnected"),
    subscribe(listener) {
      if (!listeners.size) start();
      listeners.add(listener);
      return () => {
        if (listeners.delete(listener) && !listeners.size) stop();
      };
    },
  };
}

/** A stream also re-reads in full this often, in case a change was never published. */
export const SAFETY_REFETCH_MS = 5 * 60_000;

type Subscription = { reviewId: string | null };

/** The items of a `/watch?subscriptions=` path. Undefined for other paths and bad queries. */
function listedSubscriptions(path: string): unknown[] | undefined {
  const raw = new URL(path, "http://whiteboard.local").searchParams.get("subscriptions");
  if (raw === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    // The server answers the bad query itself.
    return undefined;
  }
}

/** Which subscriptions a watch path carries: `/watch?subscriptions=`, `/watch`, `/:id/watch`. */
export function watchSubscriptions(path: string): Subscription[] {
  const url = new URL(path, "http://whiteboard.local");
  if (url.pathname !== "/watch") {
    return [{ reviewId: decodeURIComponent(url.pathname.split("/")[1] ?? "") }];
  }
  if (!url.searchParams.has("subscriptions")) return [{ reviewId: null }];
  // A bad query has nothing here to match.
  return (listedSubscriptions(path) ?? []).map((item: unknown) => ({
    reviewId:
      typeof item === "object" &&
      item !== null &&
      "reviewId" in item &&
      typeof item.reviewId === "string"
        ? item.reviewId
        : null,
  }));
}

/** Does this invalidation change what a stream with these subscriptions reads? */
export function changeMatches(
  subscriptions: readonly Subscription[],
  change: ChangedPayload,
): boolean {
  switch (change.kind) {
    case "review":
    case "activity":
      return subscriptions.some((item) => item.reviewId === change.reviewId);
    case "catalog":
      return subscriptions.some((item) => item.reviewId === null);
    case "coverage":
    case "worktree":
      return subscriptions.some((item) => item.reviewId !== null);
  }
}

export function apiErrorMessage(response: ApiResponse): string {
  try {
    const body: unknown = JSON.parse(
      response.encoding === "base64" ? atob(response.body) : response.body,
    );
    if (
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof body.error === "string"
    )
      return body.error;
  } catch {
    // Not JSON; fall through to the upstream client's wording.
  }
  return `Review request failed (${response.status}).`;
}

const withNewline = (text: string) => (text.endsWith("\n") ? text : `${text}\n`);

/** The first line of a tunnel watch body (the server sends exactly one). */
const firstLine = (body: string) => withNewline(body.split("\n", 1)[0] ?? "");

/**
 * Upstream's multi-subscription watch marks an entry unchanged since the
 * previous line with `null`. A fresh tunnel read has no previous line, so this
 * restores that contract per stream. Returns undefined when nothing changed.
 */
export function diffLine(previous: string | undefined, next: string): string | undefined {
  if (previous === next) return undefined;
  if (previous === undefined) return next;
  let before: unknown;
  let after: unknown;
  try {
    before = JSON.parse(previous);
    after = JSON.parse(next);
  } catch {
    return next;
  }
  if (!Array.isArray(before) || !Array.isArray(after) || before.length !== after.length)
    return next;
  let changed = false;
  const entries = after.map((entry: unknown, index) => {
    if (entry === null || JSON.stringify(entry) === JSON.stringify(before[index])) return null;
    changed = true;
    return entry;
  });
  return changed ? `${JSON.stringify(entries)}\n` : undefined;
}

function responseInit(response: ApiResponse): ResponseInit {
  return { status: response.status, headers: { "content-type": response.contentType } };
}

/** A JSON array line's items; undefined for anything else. */
function jsonArray(line: string | undefined): unknown[] | undefined {
  try {
    const parsed: unknown = line === undefined ? undefined : JSON.parse(line);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A live NDJSON `Response` for one watch route. A non-200 first read is
 * returned as is, like upstream's 404 before the stream opens. A later
 * failure errors the stream, so `ReviewApiClient.follow` reconnects with its
 * own backoff.
 */
export async function watchResponse(deps: {
  rpc: Pick<WhiteboardRpcClient, "api">;
  threadId?: string;
  path: string;
  signal?: AbortSignal;
  hub: LiveHub;
}): Promise<Response> {
  const { rpc, threadId, path, signal, hub } = deps;
  const read = (readPath: string) =>
    rpc.api({ method: "GET", path: readPath, ...(threadId ? { threadId } : {}) });
  signal?.throwIfAborted();
  const first = await read(path);
  signal?.throwIfAborted();
  if (first.status !== 200) return new Response(first.body, responseInit(first));

  const subscriptions = watchSubscriptions(path);
  /** Only a subscription list can be re-read in part. */
  const items = listedSubscriptions(path);
  const encoder = new TextEncoder();
  /** The last full line, every entry present. */
  let previous: string | undefined;
  let closed = false;
  let inFlight = false;
  let queued = false;
  /** What the next read covers: everything, or these subscription indices. */
  let full = false;
  const stale = new Set<number>();
  let cleanup = () => {};

  /** The next read's path, and the indices it covers when it is not every subscription. */
  const nextRead = (): { path: string; indices?: number[] } => {
    const indices = [...stale].sort((a, b) => a - b);
    const whole = full || !items || indices.length === subscriptions.length;
    full = false;
    stale.clear();
    if (whole) return { path };
    const subset = indices.map((index) => items[index]);
    return { path: `/watch?subscriptions=${encodeURIComponent(JSON.stringify(subset))}`, indices };
  };

  /** `previous` with the re-read entries put back in place; undefined if the lines do not fit. */
  const merge = (indices: number[], body: string): string | undefined => {
    const before = jsonArray(previous);
    const after = jsonArray(firstLine(body));
    if (before?.length !== subscriptions.length || after?.length !== indices.length)
      return undefined;
    const merged = [...before];
    indices.forEach((index, at) => (merged[index] = after[at]));
    return `${JSON.stringify(merged)}\n`;
  };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (raw: string) => {
        const line = diffLine(previous, firstLine(raw));
        previous = firstLine(raw);
        if (line !== undefined) controller.enqueue(encoder.encode(line));
      };
      const fail = (error: unknown) => {
        if (closed) return;
        cleanup();
        controller.error(error);
      };
      const refetch = async () => {
        inFlight = true;
        try {
          while (full || stale.size) {
            const next = nextRead();
            const response = await read(next.path);
            if (closed) return;
            if (response.status !== 200) return fail(new Error(apiErrorMessage(response)));
            const line = next.indices ? merge(next.indices, response.body) : response.body;
            if (line === undefined) full = true;
            else send(line);
          }
        } catch (error) {
          fail(error);
        } finally {
          inFlight = false;
        }
      };
      const schedule = () => {
        // An in-flight refetch loops until nothing is stale.
        if (closed || inFlight || queued) return;
        // Signals fired in one task collapse into one read.
        queued = true;
        queueMicrotask(() => {
          queued = false;
          if (!closed) void refetch();
        });
      };
      const refetchAll = () => {
        full = true;
        schedule();
      };
      const unsubscribe = hub.subscribe((change) => {
        if (change === "reconnected") return refetchAll();
        const matched = subscriptions.flatMap((item, index) =>
          changeMatches([item], change) ? [index] : [],
        );
        if (!matched.length) return;
        for (const index of matched) stale.add(index);
        schedule();
      });
      const safety = setInterval(() => {
        if (!hidden()) refetchAll();
      }, SAFETY_REFETCH_MS);
      const onAbort = () => {
        if (closed) return;
        cleanup();
        controller.close();
      };
      cleanup = () => {
        closed = true;
        unsubscribe();
        clearInterval(safety);
        signal?.removeEventListener("abort", onAbort);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      send(first.body);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(body, responseInit(first));
}
