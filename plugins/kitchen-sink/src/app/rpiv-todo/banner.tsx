// Adapted from ZhenHuangLab/bb-rpiv-todo-renderer (MIT); see LICENSE.
import {
  useComposer,
  type PluginComposerScope,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  useSettings,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import { useEffect, useId, useRef, useState } from "react";
import {
  rpivTodoContract,
  RPIV_TODO_CHANNEL,
  RPIV_TODO_EXPAND_SETTING,
  todoSignalSchema,
  type TodoSnapshot,
} from "../../shared/rpiv-todo.ts";
import { CheckIcon, ChevronDownIcon, ListTodoIcon, LoaderIcon, SquareIcon } from "./icons.tsx";
import type { TodoItem } from "../../shared/rpiv-todo-types.ts";

const STATUS_ORDER = { in_progress: 0, pending: 1, completed: 2 } as const;

/** Side chats are `ThreadChat` composers, which report their own thread. */
function threadIdFromScope(scope: PluginComposerScope): string | null {
  return scope.kind === "thread" || scope.kind === "queued-message" ? scope.threadId : null;
}

function StatusGlyph({ status }: { status: TodoItem["status"] }) {
  if (status === "completed") {
    return <CheckIcon className="rpiv-todo-icon text-muted-foreground" />;
  }
  if (status === "in_progress") {
    return <LoaderIcon className="rpiv-todo-icon rpiv-todo-spin text-foreground" />;
  }
  return <SquareIcon className="rpiv-todo-icon text-muted-foreground" />;
}

function TodoRow({ item }: { item: TodoItem }) {
  const active = item.status === "in_progress";
  const current = active && item.activeForm ? item.activeForm : null;
  const title = current ? `${item.text} — ${current}` : item.text;
  return (
    <li
      className={`flex min-w-0 items-start gap-2 text-xs ${active ? "text-foreground" : "text-muted-foreground"}`}
    >
      <StatusGlyph status={item.status} />
      <span className="min-w-0 flex-1" title={title}>
        <span className="block truncate">
          #{item.id} {item.text}
        </span>
        {current ? (
          <span className="mt-0.5 block truncate text-muted-foreground">{current}</span>
        ) : null}
      </span>
    </li>
  );
}

const snapshots = new Map<string, TodoSnapshot>();

export function TodoBanner() {
  const composer = useComposer();
  const threadId = threadIdFromScope(composer.scope);
  return threadId ? (
    <ThreadTodoBanner key={threadId} threadId={threadId} running={composer.isRunning} />
  ) : null;
}

function ThreadTodoBanner({ threadId, running }: { threadId: string; running: boolean }) {
  const rpc = useRpc<typeof rpivTodoContract>();
  const sdk = useSdk();
  const connection = useRealtimeConnectionState();
  const { values, isLoading: settingsLoading } = useSettings();
  const expandOnEnter = values?.[RPIV_TODO_EXPAND_SETTING] !== false;
  const [snapshot, setSnapshot] = useState<TodoSnapshot | null>(
    () => snapshots.get(threadId) ?? null,
  );
  const [error, setError] = useState(false);
  const [expanded, setExpanded] = useState(expandOnEnter);
  const manuallyToggled = useRef(false);
  const rpcRef = useRef(rpc);
  useEffect(() => {
    rpcRef.current = rpc;
  }, [rpc]);
  const [revision, refresh] = useState(0);
  const [pageVisible, setVisible] = useState(() => document.visibilityState !== "hidden");
  const id = useId();
  const toggleId = `${id}-toggle`;
  const bodyId = `${id}-body`;
  const items = snapshot?.items ?? [];
  const truncated = snapshot?.truncated ?? false;

  useEffect(() => {
    const changed = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);

  useEffect(() => {
    if (!settingsLoading && !manuallyToggled.current) setExpanded(expandOnEnter);
  }, [settingsLoading, expandOnEnter]);

  useRealtime(RPIV_TODO_CHANNEL, (payload) => {
    const signal = todoSignalSchema.safeParse(payload);
    if (signal.success && signal.data.threadId === threadId) refresh((value) => value + 1);
  });

  useEffect(() => {
    if (connection !== "connected" || !pageVisible) return;
    return sdk.subscribe({
      event: "thread:changed",
      threadId,
      callback: (event) => {
        if (
          event.changes.includes("history-rewritten") ||
          event.metadata?.eventTypes?.includes("system/operation")
        ) {
          refresh((value) => value + 1);
        }
      },
    });
  }, [sdk, threadId, connection, pageVisible]);

  useEffect(() => {
    if (connection !== "connected" || !pageVisible) return;
    let disposed = false;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      if (pending || disposed) return;
      pending = true;
      let continueReading = false;
      try {
        const result = await rpcRef.current.call("getRpivTodos", { threadId });
        if (disposed) return;
        snapshots.delete(threadId);
        snapshots.set(threadId, result);
        if (snapshots.size > 64) {
          const oldest = snapshots.keys().next().value;
          if (oldest) snapshots.delete(oldest);
        }
        setSnapshot(result);
        setError(false);
        continueReading = result.truncated;
      } catch {
        if (!disposed) setError(true);
      } finally {
        pending = false;
        if (!disposed && (running || continueReading)) timer = setTimeout(() => void load(), 1200);
      }
    };
    void load();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [threadId, connection, pageVisible, running, revision]);

  const sorted = [...items].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);

  if (sorted.length === 0 && (connection !== "connected" || (!error && !truncated))) return null;

  const completed = sorted.filter((item) => item.status === "completed").length;
  const current = sorted.find((item) => item.status === "in_progress");
  const currentLabel = current ? current.activeForm || current.text : null;
  const counts = `${completed}/${sorted.length} complete`;
  const visible = currentLabel ? `${counts} · ${currentLabel}` : counts;
  const aria = currentLabel
    ? `${completed} of ${sorted.length} items complete, now ${currentLabel}`
    : `${completed} of ${sorted.length} ${sorted.length === 1 ? "item" : "items"} complete`;

  return (
    <div className="rpiv-todo-card min-h-8 overflow-hidden">
      <div className="flex items-center">
        <button
          type="button"
          id={toggleId}
          aria-expanded={expanded}
          aria-controls={bodyId}
          aria-label={`To-do list: ${aria}`}
          onClick={() => {
            manuallyToggled.current = true;
            setExpanded((open) => !open);
          }}
          className="flex min-h-8 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-none px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-background/80"
        >
          <ListTodoIcon className="rpiv-todo-icon" />
          <span className="min-w-0 flex-1 truncate text-left">{visible}</span>
          <ChevronDownIcon
            className={`rpiv-todo-icon rpiv-todo-chevron${expanded ? " rpiv-todo-chevron-open" : ""}`}
          />
        </button>
      </div>
      {connection === "connected" && (error || truncated) ? (
        <output className="rpiv-todo-notice">
          {truncated ? "Loading task history…" : "Could not refresh tasks"}
          {error && connection === "connected" ? (
            <button type="button" onClick={() => refresh((value) => value + 1)}>
              Retry
            </button>
          ) : null}
        </output>
      ) : null}
      <section
        id={bodyId}
        aria-labelledby={toggleId}
        aria-hidden={!expanded}
        inert={!expanded}
        className={`rpiv-todo-body ${expanded ? "rpiv-todo-body-open" : "rpiv-todo-body-closed"}`}
      >
        <div className="overflow-hidden bg-popover">
          <ul className="max-h-40 space-y-1 overflow-y-auto px-2.5 pb-2 pt-2">
            {sorted.map((item) => (
              <TodoRow key={item.id} item={item} />
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}
