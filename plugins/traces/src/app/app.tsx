import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { PluginQueryBoundary } from "@bb-kit/core/rpc/query";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, RefObject } from "react";
import type { TraceEvent, TraceSession } from "../shared/model.ts";
import type { EventQuery } from "../shared/schema.ts";
import { rpc, definedFields } from "./rpc.ts";
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
import "./traces.css";

function KeyHelp({ onClose }: { onClose: () => void }) {
  return (
    <dialog
      className="tr-dialog tr-help"
      ref={(node) => {
        if (node && !node.open) node.showModal();
      }}
      onCancel={onClose}
      onClose={onClose}
      aria-labelledby="tr-help-title"
    >
      <div className="tr-dialog-header">
        <h2 id="tr-help-title">Keyboard shortcuts</h2>
        <button onClick={onClose} aria-label="Close keyboard shortcuts">
          ×
        </button>
      </div>
      <dl>
        {[
          ["j / k · ↓ / ↑", "Move through the focused list"],
          ["Home / End", "First or last item on this page"],
          ["Enter", "Move from sessions to timeline to inspector"],
          ["Esc", "Move back to the previous pane"],
          ["/", "Search events in the selected session"],
          ["r", "Toggle formatted and raw record"],
          ["?", "Show keyboard shortcuts"],
        ].map(([key, description]) => (
          <div key={key}>
            <dt>
              <kbd>{key}</kbd>
            </dt>
            <dd>{description}</dd>
          </div>
        ))}
      </dl>
    </dialog>
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
function usePaneSizes(width: number) {
  const workspaceRef = useRef<HTMLDivElement>(null);
  const eventsRef = useRef<HTMLDivElement>(null);
  const [pinnedSessions, pinSessions] = useStoredSize("traces:sessions");
  const [pinnedTimeline, pinTimeline] = useStoredSize("traces:timeline");
  const sessions = pinnedSessions ?? (width > 0 && width < 1000 ? 190 : 260);
  const timeline = pinnedTimeline ?? 46;
  const showSessions = useCallback(() => pinSessions(null), [pinSessions]);
  const hidden = sessions < 40;
  return {
    workspaceRef,
    eventsRef,
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
  const client = rpc.useClient();
  const status = rpc.status.useQuery({ hostId }, { refetchInterval: 3000, retry: false });
  const [session, setSession] = useState<TraceSession | null>(null);
  const [selected, setSelected] = useState<TraceEvent | null>(null);
  const [provider, setProvider] = useState(initialProvider ?? "");
  const [sessionSearch, setSessionSearch] = useState("");
  const [eventSearch, setEventSearch] = useState("");
  const [kind, setKind] = useState<EventQuery["kind"]>();
  const [topic, setTopic] = useState<EventQuery["topic"]>();
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
  const panes = usePaneSizes(width);
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
      await client.scan({ hostId, verify });
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
        target.closest("input, textarea, select, [contenteditable=true], dialog")
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
      <div className="tr-workspace" ref={panes.workspaceRef}>
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
        <div className="tr-event-workspace" ref={panes.eventsRef}>
          {session ? (
            <Timeline
              key={`${session.id}:${kind}:${topic}:${settledEvents}`}
              hostId={hostId}
              session={session}
              kind={kind}
              topic={topic}
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
            <Empty title="Your session timeline">Select a session to inspect its events.</Empty>
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
            <Empty title="Inspect an event">
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
  );
}

function TracesPanel({
  threadId,
  renderers,
}: {
  threadId?: string;
  renderers?: TraceRendererRegistry;
}) {
  const overview = rpc.overview.useQuery(definedFields({ threadId }), {
    staleTime: 10_000,
    retry: false,
  });
  const [chosen, setChosen] = useState("");
  if (overview.isPending) return <Empty title="Connecting to trace hosts…" />;
  if (overview.error)
    return <QueryError error={overview.error} retry={() => void overview.refetch()} />;
  const hosts = overview.data?.hosts ?? [];
  const context = overview.data?.context;
  const hostId = chosen || context?.hostId || hosts.find((host) => host.online)?.id;
  if (!hostId)
    return (
      <Empty title="No connected hosts">Connect a BB host to inspect its session files.</Empty>
    );
  const picker = (
    <select
      aria-label="Trace host"
      value={hostId}
      onChange={(event) => setChosen(event.target.value)}
    >
      {hosts.map((host) => (
        <option key={host.id} value={host.id}>
          {host.name}
          {host.online ? "" : " · Offline"}
        </option>
      ))}
    </select>
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
      <PluginQueryBoundary>
        <TracesPanel threadId={threadId} renderers={options.renderers} />
      </PluginQueryBoundary>
    );
  }
  function TracesNav() {
    return <TracesApp />;
  }
  return definePluginApp((app) => {
    app.slots.navPanel({
      id: "traces",
      title: "Traces",
      icon: "Activity",
      path: "traces",
      component: TracesNav,
    });
    app.slots.threadPanelAction({
      id: "traces",
      title: "Traces",
      icon: "Activity",
      component: TracesApp,
      layout: "flush",
    });
  });
}
export default createTracesApp();
