import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { TraceEvent, TraceSession } from "../shared/model.ts";
import type { EventQuery } from "../shared/schema.ts";
import { useRpcQuery } from "./rpc.ts";
import {
  Empty,
  Pages,
  QueryError,
  distinctEvidence,
  elapsedTime,
  eventTime,
  evidenceLabel,
  evidenceTag,
  moveSelection,
  providerLabel,
  actionTone,
  BackButton,
} from "./controls.tsx";
import { Alert, AlertDescription } from "./components/ui/alert.tsx";
import { Badge } from "./components/ui/badge.tsx";
import { Button } from "./components/ui/button.tsx";
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "./components/ui/item.tsx";

const EMPTY_EVENTS: TraceEvent[] = [];
const symbols: Record<string, string> = {
  message: "◉",
  reasoning: "◇",
  tool_call: "↗",
  tool_result: "↙",
  context: "▤",
  turn: "│",
  usage: "◷",
  diagnostic: "!",
};

// A tool result repeats the call that produced it. Folding the result into that
// call halves the timeline and keeps the outcome on the row a reader looks at.
// The result keeps its own event, reachable from the inspector's related list.
export function collapseResults(events: readonly TraceEvent[]) {
  const results = new Map<string, TraceEvent>();
  const calls = new Set<string>();
  for (const event of events) {
    const callId = event.tool?.callId;
    if (!callId) continue;
    if (event.kind === "tool_call") calls.add(callId);
    else if (event.kind === "tool_result" && !results.has(callId)) results.set(callId, event);
  }
  return {
    items: events.filter(
      (event) =>
        event.kind !== "tool_result" || !event.tool?.callId || !calls.has(event.tool.callId),
    ),
    results,
  };
}
function pairStatus(results: Map<string, TraceEvent>, event: TraceEvent) {
  if (event.kind !== "tool_call") return null;
  const callId = event.tool?.callId;
  return (callId ? results.get(callId)?.tool?.status : null) ?? null;
}

export function Timeline({
  hostId,
  session,
  kind,
  topic,
  includeUsage,
  query,
  selected,
  onSelect,
  listRef,
  revision,
  onInspect,
  stacked,
  onBack,
  onShowSessions,
}: {
  hostId: string;
  session: TraceSession;
  kind?: EventQuery["kind"];
  topic?: EventQuery["topic"];
  includeUsage: boolean;
  query: string;
  selected: TraceEvent | null;
  onSelect: (event: TraceEvent) => void;
  listRef: RefObject<HTMLElement | null>;
  revision: number;
  onInspect: () => void;
  stacked: boolean;
  onBack?: () => void;
  onShowSessions?: () => void;
}) {
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const page = cursors.length - 1;
  const result = useRpcQuery(
    "events",
    {
      hostId,
      sessionId: session.id,
      kind,
      topic,
      includeUsage,
      query,
      cursor: cursors[page],
      limit: 100,
    },
    { staleTime: 1000, gcTime: 0, retry: false },
  );
  const { refetch } = result;
  const lastRevision = useRef(revision);
  useEffect(() => {
    if (lastRevision.current !== revision) {
      lastRevision.current = revision;
      void refetch();
    }
  }, [revision, refetch]);
  const pageItems = result.data?.items ?? EMPTY_EVENTS;
  const { items, results } = collapseResults(pageItems);
  const selectedIndex = items.findIndex((event) => event.id === selected?.id);
  // A collapsed result is still on this page, so the inspector may hold an event
  // that has no row. Anchoring on the page rather than the rows keeps that
  // selection, and still re-anchors when a filter change drops it entirely.
  const onPage = pageItems.some((event) => event.id === selected?.id);
  useEffect(() => {
    if (stacked || !items[0]) return;
    if (!selected || (page === 0 && !onPage)) onSelect(items[0]);
  }, [stacked, items, selected, onPage, page, onSelect]);
  function selectIndex(index: number) {
    const event = items[index];
    if (!event) return;
    onSelect(event);
    listRef.current
      ?.querySelector<HTMLButtonElement>(`[data-row-index="${index}"]`)
      ?.focus({ preventScroll: false });
  }
  return (
    <div className="tr-list-column tr-timeline-column">
      <div className="tr-column-heading tr-timeline-heading">
        {onBack && <BackButton label="Back to sessions" onBack={onBack} />}
        {onShowSessions && (
          <Button variant="ghost" size="sm" className="shrink-0" onClick={onShowSessions}>
            Sessions
          </Button>
        )}
        <h2 title={session.title}>
          {session.title}
          <small>
            {" · "}
            {providerLabel(session.provider)}
            {session.model ? ` · ${session.model}` : ""}
          </small>
        </h2>
        <small className="tr-session-counters">
          {session.toolCount} tools
          {session.errorCount > 0 ? ` · ${session.errorCount} errors` : ""}
        </small>
      </div>
      {selected && !onPage && items.length > 0 && (
        <Alert role="none" className="mx-2 mt-2 w-auto">
          <AlertDescription>Inspector selection is outside this page or filter.</AlertDescription>
        </Alert>
      )}
      {result.isPending ? (
        <Empty heading="Loading events…" />
      ) : result.error ? (
        <QueryError error={result.error} retry={() => void refetch()} />
      ) : items.length === 0 ? (
        <Empty heading="No matching events">Choose another topic or clear the filter.</Empty>
      ) : (
        <section
          ref={listRef}
          tabIndex={-1}
          className="tr-timeline flex flex-col gap-0.5 p-1"
          aria-label="Trace events"
        >
          {items.map((event, index) => {
            const status = pairStatus(results, event);
            return (
              <Item asChild size="sm" className="relative flex-nowrap" key={event.id}>
                <button
                  type="button"
                  data-row-index={index}
                  data-kind={event.kind}
                  aria-pressed={selected?.id === event.id}
                  tabIndex={(selectedIndex < 0 ? index === 0 : selectedIndex === index) ? 0 : -1}
                  onKeyDown={(event) => {
                    const next = moveSelection(event, selectedIndex, items.length);
                    if (next !== null) {
                      selectIndex(next);
                      event.stopPropagation();
                    }
                    if (event.key === "Enter") {
                      event.preventDefault();
                      selectIndex(index);
                      onInspect();
                    }
                  }}
                  onClick={() => {
                    onSelect(event);
                    if (stacked) onInspect();
                  }}
                >
                  <ItemMedia aria-hidden="true">
                    <span
                      className={`tr-event-symbol${
                        event.tool?.status === "error" || status === "error"
                          ? " tr-error-symbol"
                          : ""
                      }`}
                    >
                      {symbols[event.kind] ?? "·"}
                    </span>
                  </ItemMedia>
                  <ItemContent>
                    <div className="tr-event-heading">
                      <ItemTitle className="min-w-0">{event.title}</ItemTitle>
                      {status && (
                        <Badge
                          variant={status === "error" ? "warning" : "outline"}
                          className="tr-event-status"
                        >
                          {status}
                        </Badge>
                      )}
                      <time title={eventTime(event.timestamp)}>
                        {elapsedTime(event.timestamp, session.startedAt)}
                      </time>
                    </div>
                    <ItemDescription>
                      {event.preview || event.kind.replaceAll("_", " ")}
                    </ItemDescription>
                    {event.evidence.length > 0 && (
                      <span className="tr-event-tags">
                        {distinctEvidence(event.evidence)
                          .slice(0, 3)
                          .map((evidence) => (
                            <Badge
                              key={evidenceLabel(evidence)}
                              variant={actionTone(evidence.action, "secondary")}
                              className="tr-tag"
                              title={evidenceLabel(evidence)}
                            >
                              {evidenceTag(evidence)}
                            </Badge>
                          ))}
                      </span>
                    )}
                  </ItemContent>
                  <small className="tr-event-line">L{event.provenance.line}</small>
                </button>
              </Item>
            );
          })}
        </section>
      )}
      <Pages
        page={page}
        hasNext={Boolean(result.data?.nextCursor)}
        loading={result.isFetching}
        onPrevious={() => setCursors(cursors.slice(0, -1))}
        onNext={() => {
          if (result.data?.nextCursor) setCursors([...cursors, result.data.nextCursor]);
        }}
      />
    </div>
  );
}
