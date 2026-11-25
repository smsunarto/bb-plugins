import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { TraceSession } from "../shared/model.ts";
import { useRpcQuery } from "./rpc.ts";
import { Empty, Pages, QueryError, moveSelection, providerLabel, shortDate } from "./controls.tsx";
import { Alert, AlertDescription } from "./components/ui/alert.tsx";
import { Badge } from "./components/ui/badge.tsx";
import { Item, ItemContent, ItemTitle } from "./components/ui/item.tsx";
const EMPTY_SESSIONS: TraceSession[] = [];

export function SessionList({
  hostId,
  provider,
  query,
  nativeId,
  selected,
  onSelect,
  listRef,
  onOpen,
  stacked,
  revision,
}: {
  hostId: string;
  provider?: string;
  query: string;
  nativeId?: string;
  selected: TraceSession | null;
  onSelect: (session: TraceSession) => void;
  listRef: RefObject<HTMLElement | null>;
  onOpen: () => void;
  stacked: boolean;
  revision: number;
}) {
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const page = cursors.length - 1;
  const result = useRpcQuery(
    "sessions",
    { hostId, provider, query, nativeId, cursor: cursors[page], limit: 50 },
    { staleTime: 1000, gcTime: 0, retry: false },
  );
  const lastRevision = useRef(revision);
  const { refetch } = result;
  useEffect(() => {
    if (lastRevision.current !== revision) {
      lastRevision.current = revision;
      void refetch();
    }
  }, [revision, refetch]);
  const items = result.data?.items ?? EMPTY_SESSIONS;
  useEffect(() => {
    if (!stacked && !selected && items[0]) onSelect(items[0]);
  }, [stacked, items, selected, onSelect]);
  const selectedIndex = items.findIndex((session) => session.id === selected?.id);
  const selectIndex = (index: number) => {
    const session = items[index];
    if (session) {
      onSelect(session);
      listRef.current
        ?.querySelector<HTMLButtonElement>(`[data-row-index="${index}"]`)
        ?.focus({ preventScroll: false });
    }
  };
  return (
    <div className="tr-list-column">
      <div className="tr-column-heading">
        <span className="tr-column-label">Sessions</span>
        <Badge variant="count">
          {items.length}
          {result.data?.nextCursor ? "+" : ""}
        </Badge>
      </div>
      {selected && selectedIndex < 0 && items.length > 0 && (
        <Alert role="none" className="mx-2 mt-2 w-auto">
          <AlertDescription>Current session is on another page.</AlertDescription>
        </Alert>
      )}
      {result.isPending ? (
        <Empty heading="Loading sessions…" />
      ) : result.error ? (
        <QueryError error={result.error} retry={() => void result.refetch()} />
      ) : items.length === 0 ? (
        <Empty heading="No matching sessions">Try a different filter or check Sources.</Empty>
      ) : (
        <section
          ref={listRef}
          tabIndex={-1}
          className="tr-session-list flex flex-col gap-0.5 p-1"
          aria-label="Trace sessions"
        >
          {items.map((session, index) => (
            <Item asChild size="sm" key={session.id}>
              <button
                type="button"
                id={`tr-session-${session.id}`}
                data-row-index={index}
                aria-pressed={selected?.id === session.id}
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
                    onOpen();
                  }
                }}
                onClick={() => {
                  onSelect(session);
                  if (stacked) onOpen();
                }}
              >
                <ItemContent>
                  <ItemTitle>{session.title}</ItemTitle>
                  <span className="tr-row-meta">
                    <span>{providerLabel(session.provider)}</span>
                    <span>{session.cwd?.split("/").findLast(Boolean) ?? "No workspace"}</span>
                  </span>
                  <span className="tr-row-meta">
                    <time>{shortDate(session.updatedAt)}</time>
                    <span>{session.eventCount.toLocaleString()} events</span>
                  </span>
                  {session.errorCount > 0 && (
                    <Badge variant="danger">
                      {session.errorCount} {session.errorCount === 1 ? "error" : "errors"}
                    </Badge>
                  )}
                </ItemContent>
              </button>
            </Item>
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
