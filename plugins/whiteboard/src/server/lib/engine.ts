import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { Hono } from "hono";
import {
  API_ORIGIN,
  API_PREFIX,
  NDJSON_COLLECT_LIMIT_BYTES,
  isWatchPath,
  type ApiResponse,
} from "../../shared/contracts/api-tunnel.ts";
import type { Engine, WhiteboardSettings } from "../../shared/contracts/engine.ts";
import { ReviewApiClient } from "../../shared/vendor/review-protocol/src/index.ts";
import { createHostResolver } from "./host-resolver.ts";
import { installHostIo, onWorkerExit } from "./host-io/client.ts";
import { forgetRepoContext, resolveRepoContext } from "./host-io/local-vcs.ts";
import { defaultPullRequestDeps } from "./host-io/pull-request.ts";
import { forgetProbes, probeHost } from "./host-io/probe.ts";
import { migrate } from "./migrations.ts";
import { createOpenPanel } from "./open-panel.ts";
import { createRealtime, publishEngineChanges } from "./realtime.ts";
import { trackSessionTabs } from "./session-tabs.ts";
import { whenSettingsLoaded } from "./settings.ts";
import { installDatabase } from "./sqlite.ts";
import { PLUGIN_VERSION, createStatus } from "./status.ts";
import { currentThread, desktopAvailable, runWithThread } from "./thread-context.ts";
import { createReviewApi } from "./vendor/review/src/review-api/http.ts";
import { openLocalReviewStore } from "./vendor/review/src/review-api/local-data.ts";

/** Mounted panels renew one engine-wide worktree interest lease every 30 seconds. */
export const UI_INTEREST_TTL_MS = 90_000;

const jsonError = (status: number, error: string): ApiResponse => ({
  status,
  contentType: "application/json",
  encoding: "utf8",
  body: JSON.stringify({ error }),
});

/** Cancel the upstream stream, including its subscriptions, on request or plugin abort. */
function cancellableResponse(response: Response, signal: AbortSignal): Response {
  if (!response.body) return response;
  const reader = response.body.getReader();
  let finished = false;
  const finish = () => {
    finished = true;
    signal.removeEventListener("abort", abort);
  };
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const abort = () => {
    if (finished) return;
    finish();
    void reader.cancel().catch(() => {});
    controller.error(signal.reason ?? new DOMException("Aborted", "AbortError"));
  };
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull() {
      try {
        const next = await reader.read();
        if (finished) return;
        if (next.done) {
          finish();
          controller.close();
        } else controller.enqueue(next.value);
      } catch (error) {
        if (finished) return;
        finish();
        controller.error(error);
      }
    },
    async cancel() {
      finish();
      await reader.cancel();
    },
  });
  return new Response(body, { status: response.status, headers: response.headers });
}

/** Collect a complete finite NDJSON response, or just one watch snapshot, then cancel. */
export async function collectApiResponse(response: Response, watch: boolean): Promise<ApiResponse> {
  const contentType = response.headers.get("content-type") ?? "application/octet-stream";
  const encoding = contentType.startsWith("image/") ? "base64" : "utf8";
  if (!response.body) return { status: response.status, contentType, encoding, body: "" };
  if (!contentType.includes("application/x-ndjson")) {
    const bytes = Buffer.from(await response.arrayBuffer());
    return { status: response.status, contentType, encoding, body: bytes.toString(encoding) };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const newline = watch ? next.value.indexOf(10) : -1;
      const chunk = newline < 0 ? next.value : next.value.subarray(0, newline + 1);
      size += chunk.length;
      if (size > NDJSON_COLLECT_LIMIT_BYTES)
        return jsonError(413, "Review response exceeds the 8 MiB transfer limit.");
      chunks.push(chunk);
      if (newline >= 0) break;
    }
    return {
      status: response.status,
      contentType,
      encoding,
      body: Buffer.concat(chunks).toString("utf8"),
    };
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

/** The store, Hono API, host routing and lifecycle share one owner per plugin load. */
export function createEngine(bb: BbPluginApi, settings: WhiteboardSettings): Engine {
  migrate(bb);
  installDatabase(bb.storage.database());
  const resolver = createHostResolver(bb);
  const uninstallHost = installHostIo(bb, resolver);
  const { store, data } = openLocalReviewStore(":memory:", {
    pullRequests: defaultPullRequestDeps,
  });
  const register = data.register.bind(data);
  data.register = async (root) => {
    // Registration belongs to the caller's host, even when this path is already bound.
    const hostId = await resolver.callerHost();
    const repository = await register(root);
    await resolver.bindRepository(
      { repositoryId: repository.id, rootPath: store.repositoryPath(repository.id) },
      hostId,
    );
    await resolveRepoContext(store.repositoryPath(repository.id));
    return repository;
  };
  const realtime = createRealtime(bb);
  const reviewApi = createReviewApi(
    store,
    data,
    createOpenPanel({ bb, settings, realtime }),
    undefined,
    () => ({
      desktopAvailable: desktopAvailable(),
      softwareMapEnabled: settings.softwareMapEnabled(),
    }),
    () => settings.scratchpadEnabled(),
    async () => false,
    createStatus(bb),
  );
  const app = new Hono().route(API_PREFIX, reviewApi);
  const stopChanges = publishEngineChanges(realtime, { store, data });
  const stopTabs = trackSessionTabs({ bb, store });
  const stopExits = onWorkerExit((hostId) => forgetProbes(hostId));
  const lifecycle = new AbortController();
  const activeRequests = new Set<Promise<Response>>();
  let disposed = false;
  let disposing: Promise<void> | undefined;
  let interestTimer: NodeJS.Timeout | undefined;
  let stopInterest: (() => void) | undefined;
  const expireInterest = () => {
    clearTimeout(interestTimer);
    interestTimer = undefined;
    stopInterest?.();
    stopInterest = undefined;
  };
  const renewInterest = () => {
    stopInterest ??= store.watchWorktrees();
    clearTimeout(interestTimer);
    interestTimer = setTimeout(expireInterest, UI_INTEREST_TTL_MS);
    interestTimer.unref?.();
  };
  const ready = Promise.all([
    whenSettingsLoaded(settings),
    ...store
      .repositories()
      .map(({ path }) =>
        resolveRepoContext(path).catch((error: unknown) =>
          bb.log.warn(`whiteboard: repository context could not be refreshed: ${String(error)}`),
        ),
      ),
  ]);
  const fetchApi = async (url: string, init?: RequestInit): Promise<Response> => {
    await ready;
    if (disposed)
      return new Response(JSON.stringify({ error: "Whiteboard is shutting down." }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    const signals = [lifecycle.signal, init?.signal, currentThread()?.signal].filter(
      (signal): signal is AbortSignal => !!signal,
    );
    const signal = AbortSignal.any(signals);
    signal.throwIfAborted();
    const pending = Promise.resolve(app.fetch(new Request(url, { ...init, signal })));
    activeRequests.add(pending);
    try {
      return cancellableResponse(await pending, signal);
    } finally {
      activeRequests.delete(pending);
    }
  };
  const client = new ReviewApiClient({ serverUrl: API_ORIGIN, token: "" }, fetchApi);
  return {
    async request(input) {
      return runWithThread({ threadId: input.threadId }, async () => {
        if (disposed) return jsonError(503, "Whiteboard is shutting down.");
        const response = await fetchApi(`${API_ORIGIN}${API_PREFIX}${input.path}`, {
          method: input.method,
          ...(input.method === "POST"
            ? { body: input.body, headers: { "content-type": "application/json" } }
            : {}),
        });
        const watch = isWatchPath(input.path);
        if (watch && response.ok) renewInterest();
        return collectApiResponse(response, watch);
      });
    },
    async info(input) {
      return runWithThread({ threadId: input.threadId }, async () => {
        await ready;
        if (disposed) throw new Error("Whiteboard is shutting down.");
        const snapshot = input.sessionId ? store.read(input.sessionId) : undefined;
        let structuralDiffEnabled = false;
        try {
          const hostId = await resolver.hostFor({ repositoryId: snapshot?.pins?.repositoryId });
          structuralDiffEnabled = !!(await probeHost(hostId)).diffr;
        } catch (error) {
          bb.log.warn(
            `whiteboard: structural diff capability could not be probed: ${String(error)}`,
          );
        }
        return {
          appVersion: PLUGIN_VERSION,
          softwareMapEnabled: settings.softwareMapEnabled(),
          scratchpadEnabled: settings.scratchpadEnabled(),
          structuralDiffEnabled,
        };
      });
    },
    client: () => client,
    async withThread(context, fn) {
      return runWithThread(context, async () => {
        await ready;
        if (disposed) throw new Error("Whiteboard is shutting down.");
        return fn();
      });
    },
    dispose() {
      return (disposing ??= (async () => {
        disposed = true;
        lifecycle.abort();
        stopChanges();
        stopTabs();
        realtime.dispose();
        expireInterest();
        stopExits();
        await ready;
        await Promise.allSettled(activeRequests);
        await store.close();
        await data.close();
        uninstallHost();
        forgetRepoContext();
        forgetProbes();
      })());
    },
  };
}
