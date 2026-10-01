import type { ApiResponse } from "../../shared/contracts/api-tunnel.ts";
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
 * At most one refetch is in flight per stream. Invalidations that land
 * meanwhile collapse into one follow-up. A realtime reconnect refetches every
 * live stream once, and a heartbeat renews the server's worktree interest
 * lease while the panel stays mounted.
 */

/** Realtime fan-in for one mount. The panel feeds it from `useRealtime`. */
export interface LiveHub {
  invalidate(change: ChangedPayload): void;
  /** The realtime connection came back; signals may have been missed. */
  reconnected(): void;
  subscribe(listener: (change: ChangedPayload | "reconnected") => void): () => void;
}

export function createLiveHub(): LiveHub {
  const listeners = new Set<(change: ChangedPayload | "reconnected") => void>();
  const fire = (change: ChangedPayload | "reconnected") => {
    for (const listener of Array.from(listeners)) listener(change);
  };
  return {
    invalidate: fire,
    reconnected: () => fire("reconnected"),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The server renews the worktree interest lease on every watch call; it expires after 90 s. */
export const WATCH_HEARTBEAT_MS = 30_000;

type Subscription = { reviewId: string | null };

/** Which subscriptions a watch path carries: `/watch?subscriptions=`, `/watch`, `/:id/watch`. */
export function watchSubscriptions(path: string): Subscription[] {
  const url = new URL(path, "http://whiteboard.local");
  if (url.pathname !== "/watch") {
    return [{ reviewId: decodeURIComponent(url.pathname.split("/")[1] ?? "") }];
  }
  const raw = url.searchParams.get("subscriptions");
  if (raw === null) return [{ reviewId: null }];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item: unknown) => ({
      reviewId:
        typeof item === "object" &&
        item !== null &&
        "reviewId" in item &&
        typeof item.reviewId === "string"
          ? item.reviewId
          : null,
    }));
  } catch {
    // The server answers the bad query itself; nothing here to match.
    return [];
  }
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
  heartbeatMs?: number;
}): Promise<Response> {
  const { rpc, threadId, path, signal, hub } = deps;
  const read = () => rpc.api({ method: "GET", path, ...(threadId ? { threadId } : {}) });
  signal?.throwIfAborted();
  const first = await read();
  signal?.throwIfAborted();
  if (first.status !== 200) return new Response(first.body, responseInit(first));

  const subscriptions = watchSubscriptions(path);
  const encoder = new TextEncoder();
  let previous: string | undefined;
  let closed = false;
  let inFlight = false;
  let dirty = false;
  let queued = false;
  let cleanup = () => {};

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
          do {
            dirty = false;
            const next = await read();
            if (closed) return;
            if (next.status !== 200) return fail(new Error(apiErrorMessage(next)));
            send(next.body);
          } while (dirty);
        } catch (error) {
          fail(error);
        } finally {
          inFlight = false;
        }
      };
      const schedule = () => {
        if (closed) return;
        if (inFlight) {
          dirty = true;
          return;
        }
        if (queued) return;
        // Signals fired in one task collapse into one read.
        queued = true;
        queueMicrotask(() => {
          queued = false;
          if (!closed) void refetch();
        });
      };
      const unsubscribe = hub.subscribe((change) => {
        if (change === "reconnected" || changeMatches(subscriptions, change)) schedule();
      });
      const heartbeat = setInterval(schedule, deps.heartbeatMs ?? WATCH_HEARTBEAT_MS);
      const onAbort = () => {
        if (closed) return;
        cleanup();
        controller.close();
      };
      cleanup = () => {
        closed = true;
        unsubscribe();
        clearInterval(heartbeat);
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
