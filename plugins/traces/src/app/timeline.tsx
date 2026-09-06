import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { TraceEvent, TraceSession } from "../shared/model.ts";
import type { EventQuery } from "../shared/schema.ts";
import { rpc, definedFields } from "./rpc.ts";
import { Empty, Pages, QueryError, eventTime, moveSelection } from "./controls.tsx";

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

export function Timeline({
  hostId,
  session,
  kind,
  topic,
  query,
  selected,
  onSelect,
  listRef,
  revision,
  onInspect,
  stacked,
}: {
  hostId: string;
  session: TraceSession;
  kind?: EventQuery["kind"];
  topic?: EventQuery["topic"];
  query: string;
  selected: TraceEvent | null;
  onSelect: (event: TraceEvent) => void;
  listRef: RefObject<HTMLElement | null>;
  revision: number;
  onInspect: () => void;
  stacked: boolean;
}) {
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const page = cursors.length - 1;
  const result = rpc.events.useQuery(
    definedFields({
      hostId,
      sessionId: session.id,
      kind,
      topic,
      query,
      cursor: cursors[page],
      limit: 100,
    }),
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
  const items = result.data?.items ?? EMPTY_EVENTS;
  useEffect(() => {
    if (!stacked && !selected && items[0]) onSelect(items[0]);
  }, [stacked, items, selected, onSelect]);
  const selectedIndex = items.findIndex((event) => event.id === selected?.id);
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
      <div className="tr-column-heading">
        <span>Timeline</span>
        <small>Source order</small>
      </div>
      {selected && selectedIndex < 0 && items.length > 0 && (
        <div className="tr-selection-notice">
          Inspector selection is outside this page or filter.
        </div>
      )}
      {result.isPending ? (
        <Empty title="Loading events…" />
      ) : result.error ? (
        <QueryError error={result.error} retry={() => void refetch()} />
      ) : items.length === 0 ? (
        <Empty title="No matching events">Choose another topic or clear the filter.</Empty>
      ) : (
        <section ref={listRef} tabIndex={-1} className="tr-timeline" aria-label="Trace events">
          {items.map((event, index) => (
            <button
              key={event.id}
              data-row-index={index}
              data-kind={event.kind}
              className="tr-event-row"
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
              <span
                className={`tr-event-symbol${event.tool?.status === "error" ? " tr-error-symbol" : ""}`}
                aria-hidden="true"
              >
                {symbols[event.kind] ?? "·"}
              </span>
              <span className="tr-event-content">
                <span className="tr-event-heading">
                  <strong>{event.title}</strong>
                  <time>{eventTime(event.timestamp)}</time>
                </span>
                <span className="tr-event-preview">
                  {event.preview || event.kind.replaceAll("_", " ")}
                </span>
                <span className="tr-event-tags">
                  {event.evidence.slice(0, 3).map((evidence) => (
                    <span
                      key={`${evidence.topic}-${evidence.action}-${evidence.label}-${evidence.pointer}`}
                      className={`tr-tag tr-tag-${evidence.action}`}
                    >
                      {evidence.topic} · {evidence.action.replaceAll("_", " ")}
                    </span>
                  ))}
                </span>
              </span>
              <small className="tr-event-line">L{event.provenance.line}</small>
            </button>
          ))}
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
