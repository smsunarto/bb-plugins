import {
  type BbNavigate,
  useBbContext,
  useBbNavigate,
  useComposer,
  useRealtime,
  useRealtimeConnectionState,
} from "@get-bb/plugin-sdk/app";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { toast } from "sonner";
import type { InfoOutput } from "../../shared/contracts/api-tunnel.ts";
import { CHANNELS, changedPayload } from "../../shared/contracts/channels.ts";
import { NAV_PANEL_PATH, PANEL_ACTION_ID } from "../../shared/contracts/panel.ts";
import {
  SESSION_MENTION_PROVIDER,
  sessionMentionId,
} from "../../shared/contracts/selection-handoff.ts";
import {
  type ReviewApiSummary,
  type ReviewCanvasBridge,
  type ReviewCanvasContent,
  type ReviewSourceView,
  ReviewApiClient,
} from "../../shared/vendor/review-protocol/src/index.ts";
import { registerHandoffSink } from "../bridge/agent-handoff.ts";
import { createBbBridge } from "../bridge/bb-bridge.ts";
import { createSurfaceEvents } from "../bridge/events.ts";
import { type LiveHub, createLiveHub } from "../bridge/live-watch.ts";
import { PortalHost, createPortals } from "../bridge/portals.tsx";
import { currentTheme, onDidChangeTheme } from "../bridge/theme.ts";
import { Button } from "../components/ui/button.tsx";
import { UNAVAILABLE_TITLE } from "../lib/whiteboard-info.tsx";
import { type WhiteboardRpcClient, rpc } from "../rpc.ts";
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
  useLayoutEffect(() => {
    ref.current = navigate;
  }, [navigate]);
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
function useLiveHub(client: WhiteboardRpcClient): LiveHub {
  const hub = useMemo(() => createLiveHub(client), [client]);
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

type Removal = "deleted" | "dismissed" | null;

/** Upstream closes a canvas whose session leaves the catalog or becomes dismissed. */
function useRemoved(
  client: ReviewApiClient,
  reviewId: string,
  mode: "structural" | "textual",
): Removal {
  const [removed, setRemoved] = useState<Removal>(null);
  useEffect(() => {
    setRemoved(null);
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
        if (!entry) setRemoved("deleted");
        else setRemoved(entry.dismissedAt && seenActive ? "dismissed" : null);
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
  threadId,
  navigate,
  info,
  findHost,
  setSourceView,
}: {
  bridge: ReviewCanvasBridge;
  client: ReviewApiClient;
  reviewId: string;
  threadId: string | undefined;
  navigate: BbNavigate;
  info: InfoOutput;
  findHost: ReturnType<typeof createReviewFindHost>;
  setSourceView: NonNullable<ApiContent["setSourceView"]>;
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
      setSourceView,
    }),
    [bridge, reviewId, info.structuralDiffEnabled, info.softwareMapEnabled, setSourceView],
  );
  if (removed === "deleted") return <EmptyState title={REMOVED_TITLE} />;
  if (removed === "dismissed") {
    return (
      <Dismissed client={client} reviewId={reviewId} threadId={threadId} navigate={navigate} />
    );
  }
  return (
    <div data-review-api="" className="review-api-canvas">
      <ApiCanvas key={reviewId} content={content} findHost={findHost} />
    </div>
  );
}

function Dismissed({
  client,
  reviewId,
  threadId,
  navigate,
}: {
  client: ReviewApiClient;
  reviewId: string;
  threadId: string | undefined;
  navigate: BbNavigate;
}) {
  const route = useBbContext();
  // The full page closes like Desktop's canvas: back to Home, which lists it under Dismissed.
  // Not while a thread holds the route (a split pane beside it): navigating would pull
  // that pane's focus and history entry here. Decided once, on mount: clicking Undo
  // focuses this pane, which moves the route here.
  const [closeToHome] = useState(() => !threadId && route.threadId === null);
  useEffect(() => {
    if (closeToHome) navigate.toPluginPanel(NAV_PANEL_PATH, { subPath: "", replace: true });
  }, [closeToHome, navigate]);
  if (closeToHome) return null;
  // A thread tab the server did not record, or a full page beside a thread pane.
  return (
    <EmptyState
      title="Whiteboard dismissed."
      description="It stays under Dismissed on Whiteboard Home."
    >
      <Button
        size="sm"
        variant="outline"
        onClick={() =>
          postAttention(client, reviewId, "restore").catch((error: unknown) => {
            console.warn("[whiteboard] Could not restore session:", error);
            toast.error("Could not restore the Whiteboard. Try again.");
          })
        }
      >
        Undo
      </Button>
    </EmptyState>
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
  if (!reviews) return error ? <EmptyState title={UNAVAILABLE_TITLE} description={error} /> : null;
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
  const composer = useComposer();
  const hub = useLiveHub(rpcClient);
  const sourceViewRef = useRef<ReviewSourceView>(undefined);
  const setSourceView = useCallback<NonNullable<ApiContent["setSourceView"]>>((address, view) => {
    sourceViewRef.current = address.kind === "version" ? { ...view, generation: undefined } : view;
  }, []);
  const portals = useMemo(createPortals, []);
  const events = useMemo(createSurfaceEvents, []);
  const infoRef = useRef(info);
  useLayoutEffect(() => {
    infoRef.current = info;
  }, [info]);

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
        sourceView: () => sourceViewRef.current,
      }),
    [rpcClient, threadId, sessionId, navigate, portals, events, hub],
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

  // "Add to chat" from this mount's selection popover: the quote, then a pill
  // that tells the agent which session version it came from. A thread panel
  // writes the thread's draft. The full page has no thread, so both land in
  // the new-thread draft and bb opens compose.
  useEffect(() => {
    if (!container) return;
    return registerHandoffSink(container, (handoff) => {
      composer.addQuote(handoff.quote);
      composer.insertMention({
        provider: SESSION_MENTION_PROVIDER,
        id: sessionMentionId(handoff),
        label: handoff.title,
      });
      if (!threadId) navigate.toCompose({ focusPrompt: true });
    });
  }, [container, composer, navigate, threadId]);

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
        threadId={threadId}
        navigate={navigate}
        info={info}
        findHost={findHost}
        setSourceView={setSourceView}
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
