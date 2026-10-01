import {
  API_ORIGIN,
  API_PREFIX,
  type ApiRequest,
  type ApiResponse,
  isWatchPath,
} from "../../shared/contracts/api-tunnel.ts";
import type { WhiteboardRpcClient } from "../rpc.ts";
import { type LiveHub, watchResponse } from "./live-watch.ts";

/**
 * `ReviewCanvasBridge.request` over the `api` RPC (design §3.2).
 *
 *   ReviewApiClient -> "http://127.0.0.1:1/reviews-api/<id>/file?..."
 *     -> strip origin and /reviews-api -> rpc.api({method, path, body, threadId})
 *     -> Response(status, content-type, utf8 or base64 body)
 *
 * `/watch` and `/:id/watch` become live streams (`live-watch.ts`). Other
 * NDJSON routes arrive whole from the server, so their body replays as a
 * finished stream.
 */
export type ApiRequestFn = (url: string, init?: RequestInit) => Promise<Response>;

/** The tunnel path for any URL the vendored clients build. */
export function tunnelPath(url: string): string {
  const parsed = new URL(url, API_ORIGIN);
  let pathname = parsed.pathname;
  if (pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`))
    pathname = pathname.slice(API_PREFIX.length);
  if (!pathname.startsWith("/")) pathname = `/${pathname}`;
  return `${pathname}${parsed.search}`;
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/** Rebuild the HTTP response the in-process Hono app produced. */
export function toResponse(result: ApiResponse): Response {
  const body = NULL_BODY_STATUSES.has(result.status)
    ? null
    : result.encoding === "base64"
      ? base64ToBytes(result.body)
      : result.body;
  return new Response(body, {
    status: result.status,
    headers: { "content-type": result.contentType },
  });
}

async function bodyText(body: RequestInit["body"]): Promise<string | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  return new Response(body).text();
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

/** Reject when `signal` aborts; the RPC itself cannot be cancelled, so its answer is dropped. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export function createTunnel(deps: {
  rpc: Pick<WhiteboardRpcClient, "api">;
  threadId?: string;
  hub: LiveHub;
}): ApiRequestFn {
  const { rpc, threadId, hub } = deps;
  return async (url, init = {}) => {
    const signal = init.signal ?? undefined;
    signal?.throwIfAborted();
    const method = (init.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "POST") {
      return Response.json(
        { error: `Whiteboard does not support ${method} requests.` },
        { status: 405 },
      );
    }
    const path = tunnelPath(url);
    if (method === "GET" && isWatchPath(path)) {
      return watchResponse({ rpc, threadId, path, signal, hub });
    }
    const body = await bodyText(init.body);
    const request: ApiRequest = {
      method,
      path,
      ...(body !== undefined ? { body } : {}),
      ...(threadId ? { threadId } : {}),
    };
    return toResponse(await raceAbort(rpc.api(request), signal));
  };
}
