import {
  type BbNavigate,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { InfoOutput } from "../../shared/contracts/api-tunnel.ts";
import { CHANNELS, changedPayload } from "../../shared/contracts/channels.ts";
import { NAV_PANEL_PATH, PANEL_ACTION_ID } from "../../shared/contracts/panel.ts";
import {
  type ReviewApiSummary,
  type ReviewCanvasBridge,
  type ReviewCanvasContent,
  ReviewApiClient,
} from "../../shared/vendor/review-protocol/src/index.ts";
import { createBbBridge } from "../bridge/bb-bridge.ts";
import { createSurfaceEvents } from "../bridge/events.ts";
import { type LiveHub, createLiveHub } from "../bridge/live-watch.ts";
import { PortalHost, createPortals } from "../bridge/portals.tsx";
import { currentTheme, onDidChangeTheme } from "../bridge/theme.ts";
import { rpc } from "../rpc.ts";
import "../styles/index.css";
import { ApiCanvas } from "../vendor/review/app/src/api-canvas.tsx";
import { createReviewFindHost } from "../vendor/review/app/src/review-find.tsx";
import { ReviewHome } from "../vendor/review/app/src/review-home-view.tsx";
import { ReviewContainerProvider } from "../vendor/review/app/src/review-root-context.tsx";
import { EmptyState } from "./empty-state.tsx";

/**
 * The bb version of upstream `desktop-entry.tsx` + `reviewCanvasPart.ts`
 * (design §3.8):
 *
 *   div.review-canvas-root [data-review-theme]     scope root of the vendored CSS
 *     div.review-theme-host(.review-app--theme-light)
 *       ReviewContainerProvider
 *         div[data-review-api].review-api-canvas > ApiCanvas   (sessionId)
 *         ReviewHome                                         (no sessionId)
 *     PortalHost                                     code surfaces, tooltip
 *
 * One mount owns its bridge, live-watch hub, portals and find host.
 */
export const REMOVED_TITLE = "This Whiteboard was removed.";

type ApiContent = Extract<ReviewCanvasContent, { kind: "api" }>;

const themeSubscribe = (listener: () => void) => {
  const subscription = onDidChangeTheme(listener);
  return () => subscription.dispose();
};

/** A stable `BbNavigate` that always calls the latest hook value. */
function useStableNavigate(): BbNavigate {
  const navigate = useBbNavigate();
  const ref = useRef(navigate);
  ref.current = navigate;
  return useMemo(
    () =>
      new Proxy({} as BbNavigate, {
        // Only real navigate methods: a function for every key would make the
        // proxy look thenable (`then`) and hide typos until call time.
        get: (_target, key) =>
          typeof key === "string" && typeof ref.current[key as keyof BbNavigate] === "function"
            ? (...args: unknown[]) =>
                (ref.current[key as keyof BbNavigate] as (...input: unknown[]) => unknown)(...args)
            : undefined,
      }),
    [],
  );
}

/** Feed `whiteboard:changed` and reconnects into the mount's hub. */
function useLiveHub(): LiveHub {
  const hub = useMemo(createLiveHub, []);
  useRealtime(CHANNELS.changed, (payload) => {
    const parsed = changedPayload.safeParse(payload);
    if (parsed.success) hub.invalidate(parsed.data);
  });
  // Scratchpad visibility is a catalog change the store never publishes.
  useRealtime(CHANNELS.settings, () => hub.invalidate({ kind: "catalog" }));
  const state = useRealtimeConnectionState();
  const previous = useRef(state);
  useEffect(() => {
    // The first connection comes from "connecting" and is not a reconnection.
    if (previous.current === "reconnecting" && state === "connected") hub.reconnected();
    previous.current = state;
  }, [hub, state]);
  return hub;
}

/** The host a live worktree file sits on: the thread's environment, else bb's primary host. */
function useResolveHostId(threadId: string | undefined) {
  // Read through a ref: a new SDK object must not rebuild the bridge and its streams.
  const latest = useSdk();
  const sdkRef = useRef(latest);
  sdkRef.current = latest;
  return useCallback(async (): Promise<string | undefined> => {
    const sdk = sdkRef.current;
    if (threadId) {
      try {
        const thread = await sdk.threads.get({ threadId, include: "environment" });
        if ("environment" in thread && thread.environment?.hostId) return thread.environment.hostId;
      } catch {
        // Fall back to the primary host below.
      }
    }
    try {
      return (await sdk.system.config()).primaryHostId ?? undefined;
    } catch {
      return undefined;
    }
  }, [threadId]);
}

function isFindShortcut(event: KeyboardEvent): boolean {
  return (
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === "f"
  );
}

/** Text the reader selected inside this panel, to seed find. */
function findSeed(root: HTMLElement): string | undefined {
  const selection = root.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed || !selection.anchorNode) return undefined;
  if (!root.contains(selection.anchorNode)) return undefined;
  const text = selection.toString().trim();
  return text && !text.includes("\n") ? text : undefined;
}

function postAttention(
  client: ReviewApiClient,
  reviewId: string,
  action: "view" | "dismiss" | "restore",
) {
  return client.post("/commands", {
    commandId: crypto.randomUUID(),
    operation: { type: "attention", reviewId, action },
  });
}

function catalogMode(info: InfoOutput): "structural" | "textual" {
  return info.structuralDiffEnabled ? "structural" : "textual";
}

/** Upstream closes a canvas whose session leaves the catalog or becomes dismissed. */
function useRemoved(
  client: ReviewApiClient,
  reviewId: string,
  mode: "structural" | "textual",
): boolean {
  const [removed, setRemoved] = useState(false);
  useEffect(() => {
    setRemoved(false);
    const abort = new AbortController();
    // Desktop closes on the active -> dismissed transition (reviewApiCatalogService.ts:84-87).
    // A session opened while dismissed stays readable until it is restored and dismissed again.
    let seenActive = false;
    void client.follow<ReviewApiSummary[]>(
      null,
      abort.signal,
      (reviews) => {
        const entry = reviews.find((review) => review.reviewId === reviewId);
        if (entry && !entry.dismissedAt) seenActive = true;
        setRemoved(!entry || (Boolean(entry.dismissedAt) && seenActive));
      },
      () => {},
      mode,
    );
    return () => abort.abort();
  }, [client, reviewId, mode]);
  return removed;
}

function CanvasView({
  bridge,
  client,
  reviewId,
  info,
  findHost,
}: {
  bridge: ReviewCanvasBridge;
  client: ReviewApiClient;
  reviewId: string;
  info: InfoOutput;
  findHost: ReturnType<typeof createReviewFindHost>;
}) {
  // Opening marks the session viewed, so Home stops flagging it (reviewCanvasPart.ts:364).
  useEffect(() => {
    postAttention(client, reviewId, "view").catch((error: unknown) =>
      console.warn("[whiteboard] Could not mark session viewed:", error),
    );
  }, [client, reviewId]);
  const removed = useRemoved(client, reviewId, catalogMode(info));
  const content = useMemo<ApiContent>(
    () => ({
      kind: "api",
      reviewId,
      bridge,
      structuralDiffEnabled: info.structuralDiffEnabled,
      softwareMapEnabled: info.softwareMapEnabled,
      // The server retitles thread tabs from the store (design §3.6).
      setTitle() {},
    }),
    [bridge, reviewId, info.structuralDiffEnabled, info.softwareMapEnabled],
  );
  if (removed) return <EmptyState title={REMOVED_TITLE} />;
  return (
    <div data-review-api="" className="review-api-canvas">
      <ApiCanvas key={reviewId} content={content} findHost={findHost} />
    </div>
  );
}

function HomeView({
  client,
  info,
  onOpen,
}: {
  client: ReviewApiClient;
  info: InfoOutput;
  onOpen(review: ReviewApiSummary): void;
}) {
  const [reviews, setReviews] = useState<readonly ReviewApiSummary[]>();
  const [error, setError] = useState<string>();
  const mode = catalogMode(info);
  useEffect(() => {
    const abort = new AbortController();
    void client.follow<ReviewApiSummary[]>(
      null,
      abort.signal,
      (next) => {
        setReviews(next);
        setError(undefined);
      },
      (cause) => setError(cause instanceof Error ? cause.message : String(cause)),
      mode,
    );
    return () => abort.abort();
  }, [client, mode]);
  const command = useCallback(
    async (operation: Record<string, string>) => {
      await client.post("/commands", { commandId: crypto.randomUUID(), operation });
    },
    [client],
  );
  if (!reviews)
    return error ? <EmptyState title="Whiteboard is unavailable." description={error} /> : null;
  return (
    <ReviewHome
      reviews={reviews}
      onOpen={onOpen}
      onDelete={(review) => command({ type: "delete", reviewId: review.reviewId })}
      onDismiss={(review) =>
        command({ type: "attention", reviewId: review.reviewId, action: "dismiss" })
      }
      onRestore={(review) =>
        command({ type: "attention", reviewId: review.reviewId, action: "restore" })
      }
    />
  );
}

export function WhiteboardMount({
  sessionId,
  threadId,
  info,
}: {
  /** Absent renders Home. */
  sessionId?: string;
  threadId?: string;
  info: InfoOutput;
}) {
  const rpcClient = rpc.useClient();
  const navigate = useStableNavigate();
  const hub = useLiveHub();
  const resolveHostId = useResolveHostId(threadId);
  const portals = useMemo(createPortals, []);
  const events = useMemo(createSurfaceEvents, []);
  const infoRef = useRef(info);
  infoRef.current = info;

  const bridge = useMemo(
    () =>
      createBbBridge({
        rpc: rpcClient,
        ...(threadId ? { threadId } : {}),
        ...(sessionId ? { reviewId: sessionId } : {}),
        navigate,
        // The bridge outlives settings changes; read flags through the ref.
        get info() {
          return infoRef.current;
        },
        portals,
        events,
        hub,
        resolveHostId,
      }),
    [rpcClient, threadId, sessionId, navigate, portals, events, hub, resolveHostId],
  );
  const client = useMemo(() => new ReviewApiClient(bridge.config, bridge.request), [bridge]);
  // Panels key the mount by session, so one find host per mount is one per session.
  const [findHost] = useState(createReviewFindHost);

  const theme = useSyncExternalStore(themeSubscribe, currentTheme, currentTheme);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);

  const openSession = useCallback(
    (review: ReviewApiSummary) => {
      if (threadId) {
        navigate.openThreadPanel({
          actionId: PANEL_ACTION_ID,
          title: review.title,
          params: { sessionId: review.reviewId },
        });
      } else navigate.toPluginPanel(NAV_PANEL_PATH, { subPath: review.reviewId });
    },
    [navigate, threadId],
  );

  // Cmd/Ctrl+F opens Whiteboard find only while focus is inside this panel.
  // Elsewhere the key stays bb's. A native listener on the root stops the
  // event before it reaches bb's document-level shortcut.
  useEffect(() => {
    if (!container || !sessionId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isFindShortcut(event)) return;
      if (findHost.showFind(findSeed(container))) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    container.addEventListener("keydown", onKeyDown);
    return () => container.removeEventListener("keydown", onKeyDown);
  }, [container, findHost, sessionId]);

  let body: ReactNode = null;
  if (container) {
    body = sessionId ? (
      <CanvasView
        bridge={bridge}
        client={client}
        reviewId={sessionId}
        info={info}
        findHost={findHost}
      />
    ) : (
      <HomeView client={client} info={info} onOpen={openSession} />
    );
  }

  return (
    <div ref={setContainer} className="review-canvas-root" data-review-theme={theme} tabIndex={-1}>
      <div
        className={
          theme === "light" ? "review-theme-host review-app--theme-light" : "review-theme-host"
        }
      >
        {container ? (
          <ReviewContainerProvider container={container}>{body}</ReviewContainerProvider>
        ) : null}
      </div>
      <PortalHost portals={portals} />
    </div>
  );
}
