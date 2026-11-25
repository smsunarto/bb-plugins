import { definePluginApp, experimental_ShortcutHint as ShortcutHint } from "@get-bb/plugin-sdk/app";
import { QueryClientProvider } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, RefObject } from "react";
import type { TraceEvent, TraceSession } from "../shared/model.ts";
import type { EventQuery } from "../shared/schema.ts";
import { queryClient } from "./query.ts";
import { useRpcQuery, useTracesRpc } from "./rpc.ts";
import {
  Empty,
  QueryError,
  Splitter,
  useContainerWidth,
  useDebounced,
  useDisclosure,
  useStoredSize,
  focusList,
} from "./controls.tsx";
import { SessionList } from "./session-list.tsx";
import { Timeline } from "./timeline.tsx";
import { Inspector } from "./inspector.tsx";
import type { TraceRendererRegistry } from "./renderers.tsx";
import { Sources } from "./sources.tsx";
import { TraceToolbar, TraceNotice, ThreadScope } from "./ui-chrome.tsx";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./components/ui/dialog.tsx";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select.tsx";
import { TooltipProvider } from "./components/ui/tooltip.tsx";
import "./traces.css";

const shortcuts = [
  {
    label: "j / k · ↓ / ↑",
    keys: "J K ArrowDown ArrowUp",
    description: "Move through the focused list",
  },
  { label: "Home / End", keys: "Home End", description: "First or last item on this page" },
  { label: "Enter", keys: "Enter", description: "Move from sessions to timeline to inspector" },
  { label: "Esc", keys: "Escape", description: "Move back to the previous pane" },
  { label: "/", keys: "/", description: "Search events in the selected session" },
  { label: "r", keys: "R", description: "Toggle formatted and raw record" },
  { label: "?", keys: "Shift+?", description: "Show keyboard shortcuts" },
];

function KeyHelp({ onClose }: { onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="tr-dialog tr-help" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <dl>
          {shortcuts.map(({ label, keys, description }) => (
            <div key={label}>
              <dt>
                <ShortcutHint shortcut={{ label, ariaKeyshortcuts: keys }} />
              </dt>
              <dd>{description}</dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}

type Pane = "sessions" | "timeline" | "inspector";

function shownPane(pane: Pane, hasSession: boolean, hasSelected: boolean): Pane {
  const withSelection = pane === "inspector" && !hasSelected ? "timeline" : pane;
  return withSelection === "timeline" && !hasSession ? "sessions" : withSelection;
}

function usePaneRouter({
  stacked,
  hasSession,
  hasSelected,
  sessionsRef,
  timelineRef,
  inspectorRef,
}: {
  stacked: boolean;
  hasSession: boolean;
  hasSelected: boolean;
  sessionsRef: RefObject<HTMLElement | null>;
  timelineRef: RefObject<HTMLElement | null>;
  inspectorRef: RefObject<HTMLElement | null>;
}) {
  const [pane, setPane] = useState<Pane>("sessions");
  const visible = stacked ? shownPane(pane, hasSession, hasSelected) : null;
  const entered = useRef(visible);
  useEffect(() => {
    const previous = entered.current;
    entered.current = visible;
    if (!previous || !visible || previous === visible) return;
    if (visible === "sessions") focusList(sessionsRef.current);
    else if (visible === "timeline") focusList(timelineRef.current);
    else inspectorRef.current?.focus();
  }, [visible, sessionsRef, timelineRef, inspectorRef]);
  const open = useCallback(() => {
    if (stacked) setPane("timeline");
    else focusList(timelineRef.current);
  }, [stacked, timelineRef]);
  const inspect = useCallback(() => {
    if (stacked) setPane("inspector");
    else inspectorRef.current?.focus();
  }, [stacked, inspectorRef]);
  const back = useCallback(
    () => setPane(visible === "inspector" ? "timeline" : "sessions"),
    [visible],
  );
  const reset = useCallback(() => setPane("sessions"), []);
  return { visible, open, inspect, back, reset };
}

const SESSIONS_MAX = 520;
const TIMELINE_MIN = 20;
const TIMELINE_MAX = 80;

function clamp(value: number, min: number, max: number) {
  return Math.round(Math.min(max, Math.max(min, value)));
}

// Both panes remember a pinned size. Unpinned, they follow the container width.
function usePaneSizes({
  width,
  workspaceRef,
  eventsRef,
}: {
  width: number;
  workspaceRef: RefObject<HTMLDivElement | null>;
  eventsRef: RefObject<HTMLDivElement | null>;
}) {
  const [pinnedSessions, pinSessions] = useStoredSize("traces:sessions");
  const [pinnedTimeline, pinTimeline] = useStoredSize("traces:timeline");
  const sessions = pinnedSessions ?? (width > 0 && width < 1000 ? 190 : 260);
  const timeline = pinnedTimeline ?? 46;
  const showSessions = useCallback(() => pinSessions(null), [pinSessions]);
  const hidden = sessions < 40;
  return {
    dataSessions: hidden ? "hidden" : undefined,
    showSessions: hidden ? showSessions : undefined,
    style: {
      "--tr-sessions": `${sessions}px`,
      "--tr-timeline": `${timeline}%`,
    } as CSSProperties,
    sessionsSplitter: {
      label: "Resize the session list",
      value: sessions,
      min: 0,
      max: SESSIONS_MAX,
      onMove: (clientX: number) => {
        const rect = workspaceRef.current?.getBoundingClientRect();
        if (rect) pinSessions(clamp(clientX - rect.left, 0, SESSIONS_MAX));
      },
      onStep: (direction: number, coarse: boolean) =>
        pinSessions(clamp(sessions + direction * (coarse ? 64 : 16), 0, SESSIONS_MAX)),
      onReset: () => pinSessions(null),
    },
    timelineSplitter: {
      label: "Resize the timeline",
      value: timeline,
      min: TIMELINE_MIN,
      max: TIMELINE_MAX,
      onMove: (clientX: number) => {
        const rect = eventsRef.current?.getBoundingClientRect();
        if (rect && rect.width > 0)
          pinTimeline(
            clamp(((clientX - rect.left) / rect.width) * 100, TIMELINE_MIN, TIMELINE_MAX),
          );
      },
      onStep: (direction: number, coarse: boolean) =>
        pinTimeline(clamp(timeline + direction * (coarse ? 10 : 3), TIMELINE_MIN, TIMELINE_MAX)),
      onReset: () => pinTimeline(null),
    },
  };
}

export function TraceWorkbench({
  hostId,
  nativeId,
  initialProvider,
  hostPicker,
  renderers,
}: {
  hostId: string;
  nativeId?: string;
  initialProvider?: string;
  hostPicker: React.ReactNode;
  renderers?: TraceRendererRegistry;
}) {
  const client = useTracesRpc();
  const status = useRpcQuery("status", { hostId }, { refetchInterval: 3000, retry: false });
  const [session, setSession] = useState<TraceSession | null>(null);
  const [selected, setSelected] = useState<TraceEvent | null>(null);
  const [provider, setProvider] = useState(initialProvider ?? "");
  const [sessionSearch, setSessionSearch] = useState("");
  const [eventSearch, setEventSearch] = useState("");
  const [kind, setKind] = useState<EventQuery["kind"]>();
  const [topic, setTopic] = useState<EventQuery["topic"]>();
  const [includeUsage, setIncludeUsage] = useState(false);
  const [raw, setRaw] = useState(false);
  const [sources, showSources, hideSources] = useDisclosure();
  const [help, showHelp, hideHelp] = useDisclosure();
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [currentOnly, setCurrentOnly] = useState(Boolean(nativeId));
  const sessionsRef = useRef<HTMLElement>(null);
  const timelineRef = useRef<HTMLElement>(null);
  const inspectorRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const sessionSearchRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLElement>(null);
  const width = useContainerWidth(rootRef);
  const stacked = width > 0 && width < 700;
  const workspaceRef = useRef<HTMLDivElement>(null);
  const eventsRef = useRef<HTMLDivElement>(null);
  const panes = usePaneSizes({ width, workspaceRef, eventsRef });
  const pane = usePaneRouter({
    stacked,
    hasSession: Boolean(session),
    hasSelected: Boolean(selected),
    sessionsRef,
    timelineRef,
    inspectorRef,
  });
  const { visible: visiblePane, back } = pane;
  const layout = stacked ? { "data-layout": "stack", "data-pane": visiblePane } : undefined;
  const onBack = stacked ? back : undefined;
  const settledSessions = useDebounced(sessionSearch);
  const settledEvents = useDebounced(eventSearch);
  const revision = status.data?.revision ?? 0;
  const scanning = Boolean(refreshing || status.data?.scanning);
  const sessionId = session?.id;
  const selectSession = useCallback(
    (next: TraceSession) => {
      if (sessionId !== next.id) {
        setSelected(null);
        setRaw(false);
      }
      setSession(next);
    },
    [sessionId],
  );
  async function refresh(verify: boolean) {
    if (refreshing) return;
    setRefreshing(true);
    setError("");
    try {
      await client.call("scan", { hostId, verify });
      await status.refetch();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to refresh traces.");
    } finally {
      setRefreshing(false);
    }
  }
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      const target = event.target;
      if (
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        !(target instanceof HTMLElement) ||
        !rootRef.current?.contains(target) ||
        target.closest("input, textarea, [role=combobox], [contenteditable=true], [role=dialog]")
      )
        return;
      if (event.key === "/") {
        event.preventDefault();
        const field = visiblePane && visiblePane !== "timeline" ? sessionSearchRef : searchRef;
        field.current?.focus();
      }
      if (event.key === "r" && selected) {
        event.preventDefault();
        setRaw(!raw);
      }
      if (event.key === "?") {
        event.preventDefault();
        showHelp();
      }
      if (event.key === "Escape") {
        event.preventDefault();
        if (stacked) back();
        else if (inspectorRef.current?.contains(target)) focusList(timelineRef.current);
        else focusList(sessionsRef.current);
      }
    }
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [selected, raw, showHelp, stacked, back, visiblePane]);
  return (
    <TooltipProvider delayDuration={400}>
      <main
        className="tr-app"
        ref={rootRef}
        data-sessions={panes.dataSessions}
        style={panes.style}
        {...layout}
      >
        <TraceToolbar
          sessionSearch={sessionSearch}
          setSessionSearch={setSessionSearch}
          provider={provider}
          setProvider={setProvider}
          eventSearch={eventSearch}
          setEventSearch={setEventSearch}
          kind={kind}
          setKind={setKind}
          includeUsage={includeUsage}
          setIncludeUsage={setIncludeUsage}
          providers={status.data?.providers}
          searchRef={searchRef}
          sessionSearchRef={sessionSearchRef}
          clearSession={() => {
            setSession(null);
            setSelected(null);
            pane.reset();
          }}
          topic={topic}
          setTopic={setTopic}
          hostPicker={hostPicker}
          onSources={showSources}
          onHelp={showHelp}
          onRefresh={() => void refresh(false)}
          ready={Boolean(status.data)}
          scanning={scanning}
        />
        <ThreadScope
          visible={Boolean(nativeId)}
          enabled={currentOnly}
          onChange={(value) => {
            setCurrentOnly(value);
            setSession(null);
            setSelected(null);
            pane.reset();
          }}
        />
        <TraceNotice
          message={error || status.error?.message || ""}
          retry={() => void status.refetch()}
        />
        {status.data?.lastError && <div className="tr-notice">{status.data.lastError}</div>}
        <div className="tr-workspace" ref={workspaceRef}>
          <SessionList
            key={`${hostId}:${provider}:${settledSessions}:${currentOnly}`}
            hostId={hostId}
            provider={provider || undefined}
            query={settledSessions}
            nativeId={currentOnly ? nativeId : undefined}
            selected={session}
            onSelect={selectSession}
            listRef={sessionsRef}
            onOpen={pane.open}
            stacked={stacked}
            revision={revision}
          />
          <Splitter {...panes.sessionsSplitter} />
          <div className="tr-event-workspace" ref={eventsRef}>
            {session ? (
              <Timeline
                key={`${session.id}:${kind}:${topic}:${includeUsage}:${settledEvents}`}
                hostId={hostId}
                session={session}
                kind={kind}
                topic={topic}
                includeUsage={includeUsage}
                query={settledEvents}
                selected={selected}
                onSelect={setSelected}
                listRef={timelineRef}
                revision={revision}
                onInspect={pane.inspect}
                stacked={stacked}
                onBack={onBack}
                onShowSessions={panes.showSessions}
              />
            ) : (
              <Empty heading="Your session timeline">Select a session to inspect its events.</Empty>
            )}
            <Splitter {...panes.timelineSplitter} />
            {selected ? (
              <Inspector
                key={selected.id}
                hostId={hostId}
                selected={selected}
                raw={raw}
                onRaw={setRaw}
                onSelect={setSelected}
                inspectorRef={inspectorRef}
                onBack={onBack}
                renderers={renderers}
              />
            ) : (
              <Empty heading="Inspect an event">
                Messages, tools, context, and original JSON appear here.
              </Empty>
            )}
          </div>
        </div>
        {sources && status.data && (
          <Sources
            hostId={hostId}
            status={status.data}
            onClose={hideSources}
            onSaved={() => void status.refetch()}
            onVerify={() => void refresh(true)}
            scanning={scanning}
          />
        )}
        {help && <KeyHelp onClose={hideHelp} />}
      </main>
    </TooltipProvider>
  );
}

function TracesPanel({
  threadId,
  renderers,
}: {
  threadId?: string;
  renderers?: TraceRendererRegistry;
}) {
  const overview = useRpcQuery(
    "overview",
    { threadId },
    {
      staleTime: 10_000,
      retry: false,
    },
  );
  const [chosen, setChosen] = useState("");
  if (overview.isPending) return <Empty heading="Connecting to trace hosts…" />;
  if (overview.error)
    return <QueryError error={overview.error} retry={() => void overview.refetch()} />;
  const hosts = overview.data?.hosts ?? [];
  const context = overview.data?.context;
  const hostId = chosen || context?.hostId || hosts.find((host) => host.online)?.id;
  if (!hostId)
    return (
      <Empty heading="No connected hosts">Connect a BB host to inspect its session files.</Empty>
    );
  const picker = (
    <Select value={hostId} onValueChange={setChosen}>
      <SelectTrigger aria-label="Trace host" className="tr-host-picker h-8 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {hosts.map((host) => (
            <SelectItem key={host.id} value={host.id}>
              {host.name}
              {host.online ? "" : " · Offline"}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
  return (
    <TraceWorkbench
      key={hostId}
      hostId={hostId}
      nativeId={hostId === context?.hostId ? (context?.nativeId ?? undefined) : undefined}
      initialProvider={context?.provider}
      hostPicker={picker}
      renderers={renderers}
    />
  );
}

export function createTracesApp(options: { renderers?: TraceRendererRegistry } = {}) {
  function TracesApp({ threadId }: { threadId?: string }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TracesPanel threadId={threadId} renderers={options.renderers} />
      </QueryClientProvider>
    );
  }
  function TracesNav() {
    return <TracesApp />;
  }
  return definePluginApp((app) => {
    app.slots.navPanel({
      id: "traces",
      title: "Traces",
      icon: "traces/plugin",
      path: "traces",
      component: TracesNav,
    });
    app.slots.experimental_tab({
      context: { kind: "thread" },
      availability: "action",
      id: "traces",
      title: "Traces",
      icon: "Activity",
      component: TracesApp,
      layout: "flush",
    });
  });
}
export default createTracesApp();
