import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactElement, ReactNode } from "react";
import { useRealtime } from "@get-bb/plugin-sdk/app";
import { anchorAt, placeThreads } from "../shared/anchor.ts";
import type { PlacedThread, Placement } from "../shared/anchor.ts";
import type { Anchor, Author, CommentOp, CommentsFile, CommentThread } from "../shared/comments.ts";
import type { CanvasDocument } from "../shared/document.ts";
import { newId } from "../shared/ids.ts";
import { applyOp, reflects } from "../shared/ops.ts";
import { commentsChannel } from "../shared/source.ts";
import type { CommentsSignal } from "../shared/source.ts";
import { buttonClass } from "./components.tsx";
import { rpc } from "./rpc.ts";
import { useCanvas } from "./state.tsx";

export interface ComposeTarget {
  readonly offset: number;
  readonly quote: string | null;
}

/** A live text selection inside one block, in viewport coordinates. */
export interface SelectionHint {
  readonly offset: number;
  readonly quote: string;
  readonly bottom: number;
  readonly left: number;
}

export interface CommentsValue {
  readonly sidebar: boolean;
  readonly threads: readonly CommentThread[];
  openSelection(anchor: Anchor, body: string): string;
  readonly placement: Placement;
  readonly openCount: number;
  readonly resolvedCount: number;
  readonly showResolved: boolean;
  readonly malformed: boolean;
  readonly unavailable: boolean;
  readonly error: string | null;
  readonly pending: boolean;
  readonly composing: ComposeTarget | null;
  readonly selection: SelectionHint | null;
  setShowResolved(show: boolean): void;
  setComposing(target: ComposeTarget | null): void;
  open(offset: number, quote: string | null, body: string): void;
  reply(threadId: string, body: string): void;
  resolve(threadId: string, resolved: boolean): void;
  retry(): void;
}

const CommentsContext = createContext<CommentsValue | null>(null);

const emptyFile: CommentsFile = { version: 1, threads: [] };

function isSignal(payload: unknown): payload is CommentsSignal {
  return (
    typeof payload === "object" &&
    payload !== null &&
    typeof (payload as { sha256?: unknown }).sha256 === "string"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function CommentsProvider(props: {
  readonly document: CanvasDocument;
  readonly pollIntervalMs: number;
  readonly children: ReactNode;
  readonly sidebar?: boolean;
}): ReactElement {
  const { source } = useCanvas();
  const known = useRef<string | null>(null);
  const query = rpc.comments.useQuery(
    { source, knownSha256: known.current },
    {
      refetchInterval: props.pollIntervalMs,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
      staleTime: 0,
      placeholderData: (previous) => previous,
    },
  );
  const [loaded, setLoaded] = useState<{ file: CommentsFile; malformed: boolean } | null>(null);
  const [pendingOps, setPendingOps] = useState<readonly CommentOp[]>([]);
  const [failed, setFailed] = useState<{ op: CommentOp; message: string } | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [composing, setComposingState] = useState<ComposeTarget | null>(null);
  const [selection, setSelection] = useState<SelectionHint | null>(null);
  const setComposing = useCallback((target: ComposeTarget | null) => {
    setSelection(null);
    setComposingState(target);
  }, []);

  useEffect(() => {
    if (props.sidebar) return;
    const read = (): void => {
      const current = window.getSelection();
      if (current === null || current.isCollapsed || current.rangeCount === 0) {
        setSelection(null);
        return;
      }
      const quote = current.toString().trim();
      const anchor = current.anchorNode;
      const start = anchor instanceof Element ? anchor : anchor?.parentElement;
      const block = start?.closest<HTMLElement>("[data-comment-offset]");
      if (
        block === undefined ||
        block === null ||
        quote.length === 0 ||
        !block.contains(current.focusNode)
      ) {
        setSelection(null);
        return;
      }
      const rect = current.getRangeAt(0).getBoundingClientRect();
      setSelection({
        offset: Number(block.dataset["commentOffset"]),
        quote,
        bottom: rect.bottom,
        left: rect.left,
      });
    };
    window.document.addEventListener("mouseup", read);
    return () => window.document.removeEventListener("mouseup", read);
  }, [props.sidebar]);

  // Each query result applies once. Re-running on other state changes would
  // put a stale poll over a fresher mutation result.
  const data = query.data;
  const applied = useRef<typeof data>(undefined);
  useEffect(() => {
    if (data === undefined || data === applied.current) return;
    applied.current = data;
    if (data.status !== "loaded") return;
    known.current = data.sha256;
    setLoaded({ file: data.file, malformed: data.malformed });
    setPendingOps((current) => current.filter((op) => !reflects(data.file, op)));
  }, [data]);

  const { refetch } = query;
  useRealtime(commentsChannel, (payload) => {
    if (isSignal(payload) && payload.sha256 !== known.current) void refetch();
  });

  const mutation = rpc.comment.useMutation({
    onSuccess(result, variables) {
      known.current = result.sha256;
      setLoaded({ file: result.file, malformed: false });
      setPendingOps((current) => current.filter((op) => op !== variables.op));
    },
    onError(error, variables) {
      setPendingOps((current) => current.filter((op) => op !== variables.op));
      setFailed({ op: variables.op, message: errorMessage(error) });
    },
  });
  const { mutate } = mutation;
  const submit = useCallback(
    (op: CommentOp) => {
      setPendingOps((current) => [...current, op]);
      setFailed(null);
      mutate({ source, op });
    },
    [mutate, source],
  );

  const file = useMemo(() => {
    let next = loaded?.file ?? emptyFile;
    for (const op of pendingOps) {
      if (reflects(next, op)) continue;
      try {
        next = applyOp(next, op, Date.now());
      } catch {
        continue;
      }
    }
    return next;
  }, [loaded, pendingOps]);
  const { document } = props;
  const placement = useMemo(() => placeThreads(document, file.threads), [document, file]);

  const open = useCallback(
    (offset: number, quote: string | null, body: string) => {
      const thread: CommentThread = {
        id: newId("cmt"),
        anchor: anchorAt(document, offset, quote),
        resolvedAtMs: null,
        messages: [{ id: newId("msg"), author: "user", body, createdAtMs: Date.now() }],
      };
      setComposing(null);
      submit({ op: "open", thread });
    },
    [document, setComposing, submit],
  );
  const reply = useCallback(
    (threadId: string, body: string) => {
      submit({
        op: "reply",
        threadId,
        message: { id: newId("msg"), author: "user", body, createdAtMs: Date.now() },
      });
    },
    [submit],
  );
  const openSelection = useCallback(
    (anchor: Anchor, body: string) => {
      const id = newId("cmt");
      submit({
        op: "open",
        thread: {
          id,
          anchor,
          resolvedAtMs: null,
          messages: [{ id: newId("msg"), author: "user", body, createdAtMs: Date.now() }],
        },
      });
      return id;
    },
    [submit],
  );
  const resolve = useCallback(
    (threadId: string, resolved: boolean) => submit({ op: "resolve", threadId, resolved }),
    [submit],
  );
  const retry = useCallback(() => {
    if (failed !== null) submit(failed.op);
  }, [failed, submit]);

  const value = useMemo<CommentsValue>(
    () => ({
      sidebar: props.sidebar ?? false,
      threads: file.threads,
      openSelection,
      placement,
      openCount: file.threads.filter((thread) => thread.resolvedAtMs === null).length,
      resolvedCount: file.threads.filter((thread) => thread.resolvedAtMs !== null).length,
      showResolved,
      malformed: loaded?.malformed ?? false,
      unavailable: loaded === null && query.error !== null,
      error: failed?.message ?? null,
      pending: mutation.isPending,
      composing,
      selection,
      setShowResolved,
      setComposing,
      open,
      reply,
      resolve,
      retry,
    }),
    [
      props.sidebar,
      openSelection,
      placement,
      file,
      showResolved,
      loaded,
      query.error,
      failed,
      mutation.isPending,
      composing,
      selection,
      setComposing,
      open,
      reply,
      resolve,
      retry,
    ],
  );
  return <CommentsContext.Provider value={value}>{props.children}</CommentsContext.Provider>;
}

export function useComments(): CommentsValue {
  const value = useContext(CommentsContext);
  if (value === null) throw new Error("useComments must run inside CommentsProvider");
  return value;
}

function visible(list: readonly PlacedThread[], showResolved: boolean): readonly PlacedThread[] {
  return showResolved ? list : list.filter((placed) => placed.thread.resolvedAtMs === null);
}

export function useThreadsAt(offset: number): readonly PlacedThread[] {
  const comments = useContext(CommentsContext);
  if (comments === null) return [];
  return visible(comments.placement.byOffset.get(offset) ?? [], comments.showResolved);
}

export function useDetached(): readonly PlacedThread[] {
  const comments = useComments();
  return visible(comments.placement.detached, comments.showResolved);
}

const authorLabel: Readonly<Record<Author, string>> = { user: "You", agent: "Agent" };

export function relativeTime(ms: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - ms) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}

export function CommentIcon(): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="currentColor">
      <path d="M2.5 2A1.5 1.5 0 0 0 1 3.5v7A1.5 1.5 0 0 0 2.5 12H4v2.25a.75.75 0 0 0 1.2.6L8.5 12h5a1.5 1.5 0 0 0 1.5-1.5v-7A1.5 1.5 0 0 0 13.5 2h-11Z" />
    </svg>
  );
}

function submitOnEnter(event: React.KeyboardEvent<HTMLTextAreaElement>, submit: () => void): void {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
    event.preventDefault();
    submit();
  }
}

export function Composer(props: {
  readonly quote: string | null;
  readonly placeholder: string;
  readonly submitLabel: string;
  readonly onSubmit: (body: string) => void;
  readonly onCancel: () => void;
  readonly onEscape?: () => void;
  readonly compact?: boolean;
  readonly autoFocus?: boolean;
}): ReactElement {
  const [body, setBody] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (props.autoFocus === false) return;
    field.current?.focus({ preventScroll: true });
  }, [props.autoFocus]);
  useLayoutEffect(() => {
    if (!field.current) return;
    field.current.style.height = "auto";
    field.current.style.height = `${Math.min(field.current.scrollHeight, 200)}px`;
  }, [body]);
  const trimmed = body.trim();
  const submit = (): void => {
    if (trimmed.length > 0) {
      props.onSubmit(trimmed);
      if (props.compact) setBody("");
    }
  };
  return (
    <div className="canvas-comment-composer" data-compact={props.compact || undefined}>
      {props.compact && (
        <span className="canvas-comment-avatar" aria-hidden="true">
          Y
        </span>
      )}
      {props.quote !== null ? (
        <blockquote className="canvas-comment-quote" title={props.quote}>
          {props.quote}
        </blockquote>
      ) : null}
      <textarea
        ref={field}
        rows={props.compact ? 1 : 2}
        className="canvas-comment-textarea"
        placeholder={props.placeholder}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        aria-label={props.placeholder}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.stopPropagation();
            (props.onEscape ?? props.onCancel)();
          } else if (
            props.compact &&
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            submit();
          } else submitOnEnter(event, submit);
        }}
      />
      <div className="canvas-comment-composer-actions">
        <span className="canvas-comment-shortcut" aria-hidden="true">
          {props.compact ? "Enter to send · Shift+Enter for a new line" : "⌘↵ to send"}
        </span>
        <button type="button" className="canvas-review-text-button" onClick={props.onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="canvas-review-button canvas-comment-submit"
          disabled={trimmed.length === 0}
          onClick={submit}
          aria-label={props.submitLabel}
          title={props.compact ? `${props.submitLabel} (Enter)` : undefined}
        >
          {props.compact ? (
            <svg
              viewBox="0 0 16 16"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              aria-hidden="true"
            >
              <path d="M8 12V4m-4 4 4-4 4 4" />
            </svg>
          ) : (
            props.submitLabel
          )}
        </button>
      </div>
    </div>
  );
}

function ThreadQuote({ placed, onActivate }: { placed: PlacedThread; onActivate?: () => void }) {
  const quote = placed.thread.anchor.quote;
  if (placed.match.kind === "detached")
    return (
      <blockquote className="canvas-comment-quote" title={placed.context}>
        Was: {placed.context}
      </blockquote>
    );
  if (!quote) return null;
  if (onActivate)
    return (
      <button
        type="button"
        className="canvas-comment-quote canvas-comment-quote-link"
        title={quote}
        onClick={onActivate}
        aria-label="Show commented text"
      >
        {quote}
      </button>
    );
  return (
    <blockquote className="canvas-comment-quote" title={quote}>
      {quote}
    </blockquote>
  );
}

export function MarginThread({
  placed,
  active,
  onActivate,
  onMinimize,
}: {
  placed: PlacedThread;
  active: boolean;
  onActivate(): void;
  onMinimize(): void;
}): ReactElement {
  const comments = useComments();
  const { thread } = placed;
  const resolved = thread.resolvedAtMs !== null;
  const first = thread.messages[0];
  return (
    <>
      <button
        type="button"
        className="canvas-comment-marker"
        hidden={active}
        aria-label={`Open comment by ${authorLabel[first.author]}`}
        title={`${authorLabel[first.author]}: ${first.body}`}
        onClick={onActivate}
      >
        <span className="canvas-comment-avatar" data-author={first.author} aria-hidden="true">
          {first.author === "agent" ? "A" : "Y"}
        </span>
      </button>
      <article
        className="canvas-comment-card"
        hidden={!active}
        data-thread-id={thread.id}
        data-active={active || undefined}
        data-resolved={resolved ? "" : undefined}
      >
        <button
          type="button"
          className="canvas-comment-resolve canvas-review-icon-button"
          aria-label={resolved ? "Reopen" : "Resolve"}
          title={resolved ? "Reopen" : "Resolve"}
          onClick={() => comments.resolve(thread.id, !resolved)}
        >
          <svg
            viewBox="0 0 16 16"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            <path d="m3 8 3 3 7-7" />
          </svg>
        </button>
        {placed.match.kind === "detached" && <ThreadQuote placed={placed} />}
        {thread.messages.map((message) => (
          <div className="canvas-margin-message" key={message.id}>
            <div className="canvas-comment-head">
              <span
                className="canvas-comment-avatar"
                data-author={message.author}
                aria-hidden="true"
              >
                {message.author === "agent" ? "A" : "Y"}
              </span>
              <span className="canvas-comment-author">{authorLabel[message.author]}</span>
              <time
                className="canvas-comment-time"
                dateTime={new Date(message.createdAtMs).toISOString()}
                title={new Date(message.createdAtMs).toLocaleString()}
              >
                {relativeTime(message.createdAtMs, Date.now())}
              </time>
            </div>
            <p className="canvas-comment-body whitespace-pre-wrap">{message.body}</p>
          </div>
        ))}
        <div hidden={!active} className="canvas-comment-inline-reply">
          <Composer
            compact
            autoFocus={active}
            quote={null}
            placeholder="Reply"
            submitLabel="Reply"
            onSubmit={(body) => comments.reply(thread.id, body)}
            onCancel={onMinimize}
            onEscape={onMinimize}
          />
        </div>
      </article>
    </>
  );
}

export function ThreadCard(props: {
  readonly placed: PlacedThread;
  readonly active?: boolean;
  readonly onActivate?: () => void;
}): ReactElement {
  const comments = useComments();
  const [expanded, setExpanded] = useState(props.active || comments.sidebar);
  useEffect(() => {
    if (props.active) setExpanded(true);
  }, [props.active]);
  const [replying, setReplying] = useState(false);
  const { thread, match } = props.placed;
  const first = thread.messages[0];
  const replies = thread.messages.length - 1;
  const resolved = thread.resolvedAtMs !== null;
  const now = Date.now();
  const flags = [
    resolved ? "Resolved" : null,
    match.kind === "anchored" && match.editedSince ? "Edited since" : null,
  ].filter((flag): flag is string => flag !== null);
  return (
    <div
      className="canvas-comment-card"
      data-thread-id={thread.id}
      data-active={props.active || undefined}
      data-resolved={resolved ? "" : undefined}
    >
      <button
        type="button"
        className="canvas-comment-head"
        aria-expanded={expanded}
        onClick={() => {
          props.onActivate?.();
          if (!comments.sidebar) setExpanded((value) => !value);
        }}
      >
        <span className="canvas-comment-avatar" data-author={first.author} aria-hidden="true">
          {first.author === "agent" ? "A" : "Y"}
        </span>
        <span className="canvas-comment-author">{authorLabel[first.author]}</span>
        <time
          className="canvas-comment-time"
          dateTime={new Date(first.createdAtMs).toISOString()}
          title={new Date(first.createdAtMs).toLocaleString()}
        >
          {relativeTime(first.createdAtMs, now)}
        </time>
        {flags.map((flag) => (
          <span key={flag} className="canvas-comment-flag">
            {flag}
          </span>
        ))}
        {expanded ? null : (
          <span className="canvas-comment-first">{first.body.split("\n")[0]}</span>
        )}
        {!expanded && replies > 0 ? (
          <span className="text-muted-foreground">
            {replies} {replies === 1 ? "reply" : "replies"}
          </span>
        ) : null}
      </button>
      {expanded ? (
        <div className="canvas-comment-body">
          <ThreadQuote placed={props.placed} onActivate={props.onActivate} />
          {thread.messages.map((message, index) => (
            <div key={message.id} className="canvas-comment-message">
              {index > 0 && (
                <>
                  <span className="font-medium text-foreground">{authorLabel[message.author]}</span>{" "}
                  <span className="text-muted-foreground">
                    {relativeTime(message.createdAtMs, now)}
                  </span>
                </>
              )}
              <p className="m-0 whitespace-pre-wrap">{message.body}</p>
            </div>
          ))}
          {replying ? (
            <Composer
              quote={null}
              placeholder="Reply"
              submitLabel="Reply"
              onSubmit={(body) => {
                comments.reply(thread.id, body);
                setReplying(false);
              }}
              onCancel={() => setReplying(false)}
            />
          ) : (
            <div className="canvas-comment-thread-actions">
              <button
                type="button"
                className="canvas-review-text-button"
                aria-label="Reply"
                onClick={() => setReplying(true)}
              >
                Reply…
              </button>
              <button
                type="button"
                className="canvas-review-text-button"
                onClick={() => comments.resolve(thread.id, !resolved)}
              >
                {resolved ? "Reopen" : "Resolve"}
              </button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function Block(props: {
  readonly offset: number;
  readonly children: ReactNode;
}): ReactElement {
  const comments = useContext(CommentsContext);
  const threads = useThreadsAt(props.offset);
  const host = useRef<HTMLDivElement>(null);
  if (comments === null || comments.sidebar)
    return <div className="canvas-comment-block">{props.children}</div>;
  const composing = comments.composing?.offset === props.offset ? comments.composing : null;
  const selection = comments.selection?.offset === props.offset ? comments.selection : null;
  const frame = host.current?.getBoundingClientRect() ?? { top: 0, left: 0 };

  return (
    <div
      ref={host}
      className={`canvas-comment-block${threads.length > 0 ? " canvas-commented" : ""}`}
      data-comment-offset={props.offset}
    >
      {props.children}
      <button
        type="button"
        className="canvas-comment-add"
        aria-label="Comment on this block"
        data-count={threads.length > 0 ? threads.length : undefined}
        onClick={() => comments.setComposing({ offset: props.offset, quote: null })}
      >
        {threads.length > 0 ? threads.length : <CommentIcon />}
      </button>
      {selection !== null ? (
        <button
          type="button"
          className={`canvas-comment-float ${buttonClass}`}
          style={{
            top: selection.bottom - frame.top + 4,
            left: Math.max(0, selection.left - frame.left),
          }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => comments.setComposing({ offset: props.offset, quote: selection.quote })}
        >
          Comment
        </button>
      ) : null}
      {composing !== null || threads.length > 0 ? (
        <div className="canvas-comment-cards">
          {composing !== null ? (
            <Composer
              quote={composing.quote}
              placeholder="Add a comment"
              submitLabel="Comment"
              onSubmit={(body) => comments.open(props.offset, composing.quote, body)}
              onCancel={() => comments.setComposing(null)}
            />
          ) : null}
          {threads.map((placed) => (
            <ThreadCard key={placed.thread.id} placed={placed} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function DetachedSection(): ReactElement | null {
  const detached = useDetached();
  if (detached.length === 0) return null;
  return (
    <section className="canvas-detached">
      <h2 className="canvas-detached-title">Detached comments</h2>
      <p className="m-0 mb-2 text-[0.8125em] text-muted-foreground">
        The blocks these comments pointed at are no longer in the file.
      </p>
      <div className="canvas-comment-cards">
        {detached.map((placed) => (
          <ThreadCard key={placed.thread.id} placed={placed} />
        ))}
      </div>
    </section>
  );
}

export function CommentsToolbar(): ReactElement {
  const comments = useComments();
  const total = comments.openCount + comments.resolvedCount;
  return (
    <>
      {total > 0 ? (
        <span className="text-muted-foreground">
          {comments.openCount} open {comments.openCount === 1 ? "comment" : "comments"}
        </span>
      ) : null}
      {comments.resolvedCount > 0 ? (
        <button
          type="button"
          className={buttonClass}
          aria-pressed={comments.showResolved}
          onClick={() => comments.setShowResolved(!comments.showResolved)}
        >
          {comments.showResolved ? "Hide resolved" : `Show resolved (${comments.resolvedCount})`}
        </button>
      ) : null}
      {comments.pending ? <span className="text-muted-foreground">saving comment</span> : null}
      {comments.malformed ? (
        <span className="text-amber-600 dark:text-amber-400">
          The comments file beside this canvas is malformed. Fix or delete it.
        </span>
      ) : null}
      {comments.unavailable ? (
        <span className="text-muted-foreground">comments unavailable</span>
      ) : null}
      {comments.error !== null ? (
        <button
          type="button"
          className="text-red-600 hover:underline dark:text-red-400"
          onClick={comments.retry}
        >
          Could not save comment. Retry
        </button>
      ) : null}
    </>
  );
}
