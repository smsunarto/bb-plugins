import { type BbNavigate, useBbContext, useBbNavigate, useComposer } from "@get-bb/plugin-sdk/app";
import { skipToken, useQuery } from "@tanstack/react-query";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { CodeThemeProvider } from "../lib/highlight.tsx";
import { NAV_PANEL_PATH, PANEL_ACTION_ID } from "../../shared/contracts/panel.ts";
import type { CoverageMode, InfoOutput } from "../../shared/contracts/rpc.ts";
import type {
  ReviewApiSummary,
  ReviewCanvasBridge,
  ReviewCanvasContent,
  ReviewSourceView,
} from "../../shared/review-protocol/index.ts";
import { handoffParts, registerHandoffSink } from "../bridge/agent-handoff.ts";
import { createBbBridge } from "../bridge/bb-bridge.ts";
import { createSurfaceEvents } from "../bridge/events.ts";
import { PortalHost, createPortals } from "../bridge/portals.tsx";
import { Button } from "../components/ui/button.tsx";
import { UNAVAILABLE_TITLE } from "../lib/whiteboard-info.tsx";
import { followLive, useLiveRead } from "../live.ts";
import { queryClient } from "../query.ts";
import { type WhiteboardRpcClient, useWhiteboardRpc } from "../rpc.ts";
import "../styles/index.css";
import { ApiCanvas } from "../review/api-canvas.tsx";
import { createReviewFindHost } from "../review/review-find.tsx";
import { ReviewHome } from "../review/review-home-view.tsx";
import { ReviewContainerProvider } from "../review/review-root-context.tsx";
import { createCatalogEdits } from "./catalog.ts";
import { EmptyState } from "./empty-state.tsx";

/**
 * The bb version of upstream `desktop-entry.tsx` + `reviewCanvasPart.ts`
 * (design §3.8):
 *
 *   div.light                                      bb's light token scope, display: contents
 *     div.review-canvas-root [data-review-theme]   scope root of the review CSS
 *       div.review-theme-host.review-app--theme-light
 *       ReviewContainerProvider
 *         div[data-review-api].review-api-canvas > ApiCanvas   (sessionId)
 *         ReviewHome                                         (no sessionId)
 *     PortalHost                                     code surfaces, tooltip
 *
 * One mount owns its bridge, portals and find host. Its RPC client carries
 * the panel's thread, and the catalog and the session are live reads.
 */
export const REMOVED_TITLE = "This Whiteboard was removed.";

type ApiContent = Extract<ReviewCanvasContent, { kind: "api" }>;

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
  rpc: WhiteboardRpcClient,
  reviewId: string,
  action: "view" | "dismiss" | "restore",
) {
  return rpc.command({
    commandId: crypto.randomUUID(),
    operation: { type: "attention", reviewId, action },
  });
}

function catalogMode(info: InfoOutput): CoverageMode {
  return info.structuralDiffEnabled ? "structural" : "textual";
}

type Removal = "deleted" | "dismissed" | null;

/** Upstream closes a canvas whose session leaves the catalog or becomes dismissed. */
function useRemoved(threadId: string | undefined, reviewId: string, mode: CoverageMode): Removal {
  const [removed, setRemoved] = useState<Removal>(null);
  const catalog = useLiveRead("sessions", { threadId, mode });
  useEffect(() => {
    setRemoved(null);
    const abort = new AbortController();
    // Desktop closes on the active -> dismissed transition (reviewApiCatalogService.ts:84-87).
    // A session opened while dismissed stays readable until it is restored and dismissed again.
    let seenActive = false;
    followLive(
      catalog,
      abort.signal,
      (reviews) => {
        const entry = reviews.find((review) => review.reviewId === reviewId);
        if (entry && !entry.dismissedAt) seenActive = true;
        if (!entry) setRemoved("deleted");
        else setRemoved(entry.dismissedAt && seenActive ? "dismissed" : null);
      },
      () => {},
    );
    return () => abort.abort();
  }, [catalog, reviewId]);
  return removed;
}

function CanvasView({
  bridge,
  rpc,
  reviewId,
  threadId,
  navigate,
  info,
  findHost,
  setSourceView,
}: {
  bridge: ReviewCanvasBridge;
  rpc: WhiteboardRpcClient;
  reviewId: string;
  threadId: string | undefined;
  navigate: BbNavigate;
  info: InfoOutput;
  findHost: ReturnType<typeof createReviewFindHost>;
  setSourceView: NonNullable<ApiContent["setSourceView"]>;
}) {
  // Opening marks the session viewed, so Home stops flagging it (reviewCanvasPart.ts:364).
  useEffect(() => {
    postAttention(rpc, reviewId, "view").catch((error: unknown) =>
      console.warn("[whiteboard] Could not mark session viewed:", error),
    );
  }, [rpc, reviewId]);
  const removed = useRemoved(threadId, reviewId, catalogMode(info));
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
    return <Dismissed rpc={rpc} reviewId={reviewId} threadId={threadId} navigate={navigate} />;
  }
  return (
    <div data-review-api="" className="review-api-canvas">
      <ApiCanvas key={reviewId} content={content} threadId={threadId} findHost={findHost} />
    </div>
  );
}

function Dismissed({
  rpc,
  reviewId,
  threadId,
  navigate,
}: {
  rpc: WhiteboardRpcClient;
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
          postAttention(rpc, reviewId, "restore").catch((error: unknown) => {
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
  rpc,
  info,
  onOpen,
  threadId,
}: {
  rpc: WhiteboardRpcClient;
  info: InfoOutput;
  onOpen(review: ReviewApiSummary): void;
  threadId: string | undefined;
}) {
  const [error, setError] = useState<string>();
  const mode = catalogMode(info);
  const live = useLiveRead("sessions", { threadId, mode });
  // The live read refreshes this cache. Keep its last result across page
  // navigation, scoped to the thread whose scratchpad the server includes.
  const queryKey = useMemo(
    () => ["whiteboard", "catalog", threadId ?? null, mode],
    [threadId, mode],
  );
  const catalog = useMemo(() => createCatalogEdits(queryKey), [queryKey]);
  const { data: reviews } = useQuery<readonly ReviewApiSummary[]>(
    { queryKey, queryFn: skipToken },
    queryClient,
  );
  useEffect(() => {
    const abort = new AbortController();
    followLive(
      live,
      abort.signal,
      (next) => {
        catalog.receive(next);
        setError(undefined);
      },
      (cause) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
    return () => abort.abort();
  }, [live, catalog]);
  const remove = (review: ReviewApiSummary) =>
    catalog.command(review.reviewId, "delete", () =>
      rpc.command({
        commandId: crypto.randomUUID(),
        operation: { type: "delete", reviewId: review.reviewId },
      }),
    );
  // ReviewHome reports a failed delete itself, and swallows the other two.
  const attention = (review: ReviewApiSummary, action: "dismiss" | "restore") =>
    catalog
      .command(review.reviewId, action, () => postAttention(rpc, review.reviewId, action))
      .catch((cause: unknown) => {
        console.warn(`[whiteboard] Could not ${action} session:`, cause);
        toast.error(`Could not ${action} the Whiteboard. Try again.`);
        throw cause;
      });
  if (!reviews) return error ? <EmptyState title={UNAVAILABLE_TITLE} description={error} /> : null;
  return (
    <ReviewHome
      reviews={reviews}
      onOpen={onOpen}
      onDelete={remove}
      onDismiss={(review) => attention(review, "dismiss")}
      onRestore={(review) => attention(review, "restore")}
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
  const rpc = useWhiteboardRpc(threadId);
  const navigate = useStableNavigate();
  const composer = useComposer();
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
        rpc,
        ...(threadId ? { threadId } : {}),
        ...(sessionId ? { reviewId: sessionId } : {}),
        navigate,
        // The bridge outlives settings changes; read flags through the ref.
        get info() {
          return infoRef.current;
        },
        portals,
        events,
        sourceView: () => sourceViewRef.current,
      }),
    [rpc, threadId, sessionId, navigate, portals, events],
  );
  // Panels key the mount by session, so one find host per mount is one per session.
  const [findHost] = useState(createReviewFindHost);

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
      composer.insert(handoffParts(handoff), { at: "end", block: true });
      composer.focus();
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
        rpc={rpc}
        reviewId={sessionId}
        threadId={threadId}
        navigate={navigate}
        info={info}
        findHost={findHost}
        setSourceView={setSourceView}
      />
    ) : (
      <HomeView rpc={rpc} info={info} onOpen={openSession} threadId={threadId} />
    );
  }

  return (
    // Always light. `.light` is bb's light token scope: bb's tokens resolve to
    // its light palette on this wrapper, even while bb is dark, and the canvas
    // inherits them resolved. It cannot sit on the canvas root, which redeclares
    // bb names such as --ink that bb's light tokens read.
    <div className="light" style={{ display: "contents" }}>
      <div
        ref={setContainer}
        className="review-canvas-root"
        data-review-theme="light"
        tabIndex={-1}
      >
        <div className="review-theme-host review-app--theme-light">
          {container ? (
            <ReviewContainerProvider container={container}>
              <CodeThemeProvider>{body}</CodeThemeProvider>
            </ReviewContainerProvider>
          ) : null}
        </div>
        <PortalHost portals={portals} />
      </div>
    </div>
  );
}
