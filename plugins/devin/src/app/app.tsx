import { useCallback, useEffect, useRef, useState } from "react";
import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import {
  definePluginApp,
  experimental_copyToClipboard,
  useComposer,
  useRealtimeConnectionState,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import type { PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";
import { DEVIN_LOGO_PATHS, DEVIN_LOGO_VIEW_BOX } from "../shared/devin-brand.ts";
import { cloudSessionSettled, DEVIN_PROVIDER_ID } from "../shared/devin.ts";
import { Badge } from "./components/ui/badge.tsx";
import { Button } from "./components/ui/button.tsx";
import { Card, CardContent } from "./components/ui/card.tsx";
import { StatusDot } from "./components/ui/status-dot.tsx";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "./components/ui/input-group.tsx";
import { Toggle } from "./components/ui/toggle.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./components/ui/tooltip.tsx";
import { queryClient } from "./query.ts";
import { queryKey, useRpcMutation, useRpcQuery } from "./rpc.ts";
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
  const composer = useComposer();
  const session = useRpcQuery(
    "cloudSession",
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
  const refresh = useCallback(() => {
    const key = queryKey("cloudSession", { threadId: threadId ?? "" });
    const inFlight = queryClient.getQueryState(key)?.fetchStatus === "fetching";
    const read = refetch({ cancelRefetch: false });
    if (inFlight) void read.then(() => refetch({ cancelRefetch: false }));
  }, [queryClient, threadId, refetch]);

  useEffect(() => {
    if (!live) return;
    return sdk.subscribe({
      event: "thread:changed",
      threadId,
      callback: (event) => {
        if (event.id === threadId && movesCloudSession(event)) refresh();
      },
    });
  }, [sdk, threadId, live, refresh]);

  const lastConnection = useRef(connection);
  useEffect(() => {
    const previous = lastConnection.current;
    lastConnection.current = connection;
    if (live && connection === "connected" && previous !== "connected") refresh();
  }, [connection, live, refresh]);

  useEffect(() => {
    if (!live) return;
    return composer.onSubmitted(() => refresh());
  }, [composer, live, refresh]);

  return session.data;
}

export function DevinIcon({ className = "devin-cloud-logo" }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className} viewBox={DEVIN_LOGO_VIEW_BOX}>
      {DEVIN_LOGO_PATHS.map((path) => (
        <path d={path} fill="currentColor" key={path} />
      ))}
    </svg>
  );
}

/** A press, or the new thread's first command consuming an armed intent,
 *  outdates the cached read, so the toggle's next appearance asks again. */
function markIntentStale(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: queryKey("cloudIntent"), refetchType: "none" });
}

/** New-thread banner, shown while Devin is selected. It is a banner rather
 *  than an action so that, while hidden, it does not hold one of bb's three
 *  inline action slots. Pressing it arms Devin
 *  Cloud for the next thread on the server; the thread's first command claims
 *  it. The server owns the armed state; a reappearance re-reads it once the
 *  last read is stale or a submit may have consumed it. */
function CloudToggle() {
  const composer = useComposer();
  // The composer reports its picker's provider, so split panes each gate on
  // their own composer.
  const visible = composer.selection?.providerId === DEVIN_PROVIDER_ID;
  const queryClient = useQueryClient();
  const intent = useRpcQuery("cloudIntent", null, {
    enabled: visible,
    staleTime: CLOUD_INTENT_STALE_MS,
  });
  const setIntent = useRpcMutation("setCloudIntent");
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
  const submitting = composer.isSubmitting;
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
  if (!visible) return null;
  return (
    <div className="mb-2 flex">
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Toggle
              className="h-6 gap-1 rounded-full px-2 text-xs"
              disabled={submitting}
              onPressedChange={toggle}
              pressed={pressed}
              size="sm"
              variant="outline"
            >
              <DevinIcon />
              Cloud
            </Toggle>
          </TooltipTrigger>
          <TooltipContent>Run this thread on a Devin Cloud VM</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}

function CloudBanner() {
  const { scope } = useComposer();
  const threadId = scope.kind === "thread" ? scope.threadId : null;
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
    // bb's own writer: the native clipboard in bb Desktop, no focus or secure
    // origin needed. It resolves false instead of rejecting.
    const written = await experimental_copyToClipboard({ text: active.attachCommand });
    setCopied(written ? "copied" : "failed");
  };

  return (
    <Card size="xs" className="mb-2">
      <CardContent>
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
            <DevinIcon />
            <span className="shrink-0 text-sm font-medium text-foreground">Devin Cloud</span>
            {active === null ? (
              <span className="truncate text-xs">Starting a cloud session…</span>
            ) : (
              <Button asChild className="min-w-0 shrink" size="xs" variant="link">
                <a href={active.url} rel="noreferrer" target="_blank" title={active.url}>
                  <span className="truncate">Open in Devin</span>
                </a>
              </Button>
            )}
          </div>
          <Badge
            aria-live="polite"
            className="min-w-18 justify-center gap-1 uppercase"
            data-state={data.state}
            variant={active === null ? "secondary" : "info"}
          >
            <StatusDot tone="current" size="sm" pulse={active === null} />
            {active === null ? "Starting" : "Active"}
          </Badge>
        </div>

        <InputGroup className="mt-2">
          <InputGroupInput
            aria-label="Devin attach command"
            className="min-w-0 font-mono text-xs"
            placeholder="Waiting for the Devin session ID…"
            readOnly
            title={active?.attachCommand}
            value={active?.attachCommand ?? ""}
          />
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              type="button"
              aria-label="Copy Devin attach command"
              className="w-20"
              disabled={active === null}
              onClick={() => void copy()}
            >
              {copied === "copied" ? "Copied" : copied === "failed" ? "Copy failed" : "Copy"}
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      </CardContent>
    </Card>
  );
}

function CloudToggleBanner() {
  return (
    <QueryClientProvider client={queryClient}>
      <CloudToggle />
    </QueryClientProvider>
  );
}

function CloudSessionBanner() {
  return (
    <QueryClientProvider client={queryClient}>
      <CloudBanner />
    </QueryClientProvider>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_providerIcon({
    providerKind: "agent",
    providerId: "acp-devin",
    icon: DevinIcon,
  });
  // Cloud is chosen at thread creation, so the toggle lives on the new-thread
  // composer only; the banner covers the thread after that.
  app.composer.customize({
    id: "cloud-toggle",
    scopes: ["new-thread"],
    banners: [
      {
        id: "cloud-toggle",
        chrome: "bare",
        component: CloudToggleBanner,
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
