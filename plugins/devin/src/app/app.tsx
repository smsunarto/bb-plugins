import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { PluginQueryBoundary } from "@bb-kit/core/rpc/query";
import {
  definePluginApp,
  experimental_useProviders,
  useComposer,
  useComposerView,
  useRealtimeConnectionState,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import type { PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";
import { DEVIN_LOGO_PATHS, DEVIN_LOGO_VIEW_BOX } from "../shared/devin-brand.ts";
import { cloudSessionSettled, DEVIN_PROVIDER_ID } from "../shared/devin.ts";
import { rpc } from "./rpc.ts";
import "./devin.css";

/** Only this toggle and a thread's first command change the armed intent, and
 *  both mark it stale, so a read stays good across remounts for this long. */
const CLOUD_INTENT_STALE_MS = 60_000;

type ThreadChange = Parameters<
  Extract<Parameters<PluginBrowserBbSdk["subscribe"]>[0], { event: "thread:changed" }>["callback"]
>[0];

/** Thread changes that can move the banner. A turn starting follows the first
 *  command, which claims the thread's target, and the bridge appends
 *  `thread/identity` once Devin Cloud names the session. */
function movesCloudSession(event: ThreadChange): boolean {
  if (event.changes.includes("status-changed")) return true;
  if (!event.changes.includes("events-appended")) return false;
  const types = event.metadata?.eventTypes;
  return types === undefined || types.includes("thread/identity");
}

/**
 * The banner's view of a thread's Cloud session, refreshed by the thread's own
 * changes instead of a timer. Once settled it neither refetches nor listens.
 * Changes missed while realtime was down are reconciled on reconnect, and a
 * submit from this composer re-reads it in case its turn claimed the target.
 */
function useCloudSession(threadId: string | null) {
  const sdk = useSdk();
  const connection = useRealtimeConnectionState();
  const submitting = useComposerView().run.isSubmitting;
  const session = rpc.cloudSession.useQuery(
    { threadId: threadId ?? "" },
    {
      enabled: threadId !== null,
      staleTime: (query) => {
        const data = query.state.data;
        return data !== undefined && cloudSessionSettled(data) ? Infinity : 0;
      },
    },
  );
  const queryClient = useQueryClient();
  const settled = session.data !== undefined && cloudSessionSettled(session.data);
  const live = threadId !== null && !settled;
  const { refetch } = session;
  // Panes showing the same thread share one fetch per change. A read already
  // in flight may predate the change, so it gets one follow-up after it.
  const refresh = useRef(() => {});
  refresh.current = () => {
    const key = rpc.cloudSession.queryKey({ threadId: threadId ?? "" });
    const inFlight = queryClient.getQueryState(key)?.fetchStatus === "fetching";
    const read = refetch({ cancelRefetch: false });
    if (inFlight) void read.then(() => refetch({ cancelRefetch: false }));
  };

  useEffect(() => {
    if (!live) return;
    return sdk.subscribe({
      event: "thread:changed",
      threadId,
      callback: (event) => {
        if (event.id === threadId && movesCloudSession(event)) refresh.current();
      },
    });
  }, [sdk, threadId, live]);

  const lastConnection = useRef(connection);
  useEffect(() => {
    const previous = lastConnection.current;
    lastConnection.current = connection;
    if (live && connection === "connected" && previous !== "connected") refresh.current();
  }, [connection, live]);

  const wasSubmitting = useRef(submitting);
  useEffect(() => {
    const previous = wasSubmitting.current;
    wasSubmitting.current = submitting;
    if (live && previous && !submitting) refresh.current();
  }, [submitting, live]);

  return session.data;
}

function DevinLogo() {
  return (
    <svg aria-hidden="true" className="devin-cloud-logo" viewBox={DEVIN_LOGO_VIEW_BOX}>
      {DEVIN_LOGO_PATHS.map((path) => (
        <path d={path} fill="currentColor" key={path} />
      ))}
    </svg>
  );
}

/**
 * True while this composer's model picker shows Devin. The composer view has
 * no selected-provider signal (SDK 0.5.29), so this reads the markers the
 * host paints into the picker trigger: the provider icon's
 * `data-provider-logo` mask and the trigger's `title="Devin: …"`. It is scoped
 * to the surrounding `[data-app-composer]` so split panes gate on their own
 * picker, and hides while the provider directory cannot say what Devin looks
 * like. Same approach as the Amp plugin's Orb toggle.
 */
function useDevinSelected(): { setAnchor: (node: HTMLElement | null) => void; visible: boolean } {
  const providersState = experimental_useProviders();
  const devin = providersState.providers.find((provider) => provider.id === DEVIN_PROVIDER_ID);
  const logoUrl = devin?.logoUrl ?? null;
  const displayName = devin?.displayName ?? null;
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (anchor === null) return;
    if (providersState.status !== "ready" || (logoUrl === null && displayName === null)) {
      setVisible(false);
      return;
    }
    // Overflowed composer actions portal to <body>. Only one new-thread
    // composer exists, so the document-wide picker is still the right one.
    const root: ParentNode = anchor.closest("[data-app-composer]") ?? anchor.ownerDocument;
    const check = () => {
      const logoSelected =
        logoUrl !== null &&
        Array.from(root.querySelectorAll("[data-provider-logo]")).some(
          (mark) => mark.getAttribute("data-provider-logo") === logoUrl,
        );
      const titleSelected =
        displayName !== null &&
        Array.from(root.querySelectorAll("[title]")).some(
          (node) =>
            node.closest(".devin-cloud-toggle-slot") === null &&
            (node.getAttribute("title") ?? "").startsWith(`${displayName}:`),
        );
      setVisible(logoSelected || titleSelected);
    };
    check();
    const observer = new MutationObserver(check);
    observer.observe(root instanceof Document ? root.body : root, {
      attributeFilter: ["data-provider-logo", "title"],
      attributes: true,
      childList: true,
      subtree: true,
    });
    return () => observer.disconnect();
  }, [anchor, logoUrl, displayName, providersState.status]);
  return { setAnchor, visible };
}

/** A press, or the new thread's first command consuming an armed intent,
 *  outdates the cached read, so the toggle's next appearance asks again. */
function markIntentStale(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: rpc.cloudIntent.queryKey(), refetchType: "none" });
}

/** New-thread action, shown while Devin is selected. Pressing it arms Devin
 *  Cloud for the next thread on the server; the thread's first command claims
 *  it. The server owns the armed state; a reappearance re-reads it once the
 *  last read is stale or a submit may have consumed it. */
function CloudToggle() {
  const composer = useComposer();
  const view = useComposerView();
  const gate = useDevinSelected();
  const queryClient = useQueryClient();
  const intent = rpc.cloudIntent.useQuery({
    enabled: gate.visible,
    staleTime: CLOUD_INTENT_STALE_MS,
  });
  const setIntent = rpc.setCloudIntent.useMutation();
  const [pressed, setPressed] = useState(false);
  /** A read fetched before the latest press describes the state that press
   *  replaced, so only a newer read may overwrite the button. */
  const pressedAt = useRef(0);
  const pressSeq = useRef(0);
  useEffect(() => {
    if (intent.data !== undefined && intent.dataUpdatedAt > pressedAt.current) {
      setPressed(intent.data.armed);
    }
  }, [intent.data, intent.dataUpdatedAt]);
  const submitting = view.run.isSubmitting;
  useEffect(() => {
    if (submitting) markIntentStale(queryClient);
  }, [submitting, queryClient]);
  const toggle = () => {
    const next = !pressed;
    const seq = ++pressSeq.current;
    pressedAt.current = Date.now();
    setPressed(next);
    markIntentStale(queryClient);
    setIntent.mutate(
      { armed: next },
      {
        onError: () => {
          if (seq === pressSeq.current) setPressed(!next);
        },
      },
    );
    composer.focus();
  };
  return (
    <span className="devin-cloud-toggle-slot" ref={gate.setAnchor}>
      {gate.visible ? (
        <button
          aria-pressed={pressed}
          className="devin-cloud-toggle"
          disabled={view.run.isSubmitting}
          onClick={toggle}
          title="Run this thread on a Devin Cloud VM"
          type="button"
        >
          <DevinLogo />
          Cloud
        </button>
      ) : null}
    </span>
  );
}

function CloudBanner() {
  const view = useComposerView();
  const threadId = view.scope.kind === "thread" ? view.scope.threadId : null;
  const data = useCloudSession(threadId);
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (copied === "idle") return;
    const timer = setTimeout(() => setCopied("idle"), 1_800);
    return () => clearTimeout(timer);
  }, [copied]);

  if (threadId === null || data === undefined) return null;
  if (data.state === "hidden" || data.state === "unclaimed") return null;
  const active = data.state === "active" ? data : null;

  const copy = async () => {
    if (active === null) return;
    try {
      await navigator.clipboard.writeText(active.attachCommand);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  };

  return (
    <div className="mb-2 rounded-lg border border-border bg-card p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
          <DevinLogo />
          <span className="shrink-0 text-sm font-medium text-foreground">Devin Cloud</span>
          {active === null ? (
            <span className="truncate text-xs">Starting a cloud session…</span>
          ) : (
            <a
              className="truncate text-xs underline-offset-2 hover:text-foreground hover:underline"
              href={active.url}
              rel="noreferrer"
              target="_blank"
              title={active.url}
            >
              Open in Devin
            </a>
          )}
        </div>
        <span aria-live="polite" className="devin-cloud-status" data-state={data.state}>
          <span aria-hidden="true" className="devin-cloud-status-dot" />
          {active === null ? "Starting" : "Active"}
        </span>
      </div>

      <div className="mt-2 flex min-w-0 items-stretch overflow-hidden rounded-md border border-border bg-background">
        <input
          aria-label="Devin attach command"
          className="min-w-0 flex-1 bg-transparent px-2.5 py-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground"
          placeholder="Waiting for the Devin session ID…"
          readOnly
          title={active?.attachCommand}
          value={active?.attachCommand ?? ""}
        />
        <button
          aria-label="Copy Devin attach command"
          className="devin-cloud-copy w-20 border-l border-border px-2.5 py-1.5 text-xs font-medium disabled:opacity-50"
          disabled={active === null}
          onClick={() => void copy()}
          type="button"
        >
          {copied === "copied" ? "Copied" : copied === "failed" ? "Copy failed" : "Copy"}
        </button>
      </div>
    </div>
  );
}

function CloudToggleAction() {
  return (
    <PluginQueryBoundary>
      <CloudToggle />
    </PluginQueryBoundary>
  );
}

function CloudSessionBanner() {
  return (
    <PluginQueryBoundary>
      <CloudBanner />
    </PluginQueryBoundary>
  );
}

export default definePluginApp((app) => {
  // Cloud is chosen at thread creation, so the toggle lives on the new-thread
  // composer only; the banner covers the thread after that.
  app.composer.customize({
    id: "cloud-toggle",
    scopes: ["new-thread"],
    actions: [
      {
        id: "cloud-toggle",
        component: CloudToggleAction,
      },
    ],
  });
  app.composer.customize({
    id: "cloud-session",
    scopes: ["thread"],
    banners: [
      {
        id: "cloud-session",
        chrome: "bare",
        component: CloudSessionBanner,
      },
    ],
  });
});
