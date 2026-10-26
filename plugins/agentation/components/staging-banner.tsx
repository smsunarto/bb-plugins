import {
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  experimental_usePluginId,
  useComposer,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@bb-plugins/icons";
import type { StoredAnnotation } from "@/lib/afs.ts";
import {
  ANNOTATION_MENTION_PROVIDER,
  annotationMentionItemId,
  annotationMentionLabel,
  annotationMentionLabelParts,
  annotationSourceLabel,
  withoutAnnotationMentions,
} from "@/lib/staging-display.ts";
import { broadcastType, sharedRequest } from "@/lib/shared-request.ts";
import type { rpcContract } from "@/server.ts";

/**
 * `threadId` is null in the new-thread composer: no thread exists to send to
 * yet, so the banner only mentions annotations, and the dispatch that creates
 * the thread assigns them.
 */
function StagedAnnotations({ threadId }: { threadId: string | null }) {
  const rpc = useRpc<typeof rpcContract>();
  const composer = useComposer();
  const pluginId = experimental_usePluginId();
  const [annotations, setAnnotations] = useState<StoredAnnotation[]>([]);
  const [threadTitles, setThreadTitles] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [discardingId, setDiscardingId] = useState<string | null>(null);
  const [discardIds, setDiscardIds] = useState<string[] | null>(null);
  const [isDiscarding, setIsDiscarding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshSequence = useRef(0);
  const actionInFlight = useRef(false);
  const annotationDescriptionPrefix = useId();

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    try {
      // Every thread composer in every pane shows this banner; they share
      // one request per change.
      const result = await sharedRequest("listStagedAnnotations", () =>
        rpc.call("listStagedAnnotations"),
      );
      if (sequence !== refreshSequence.current) return;
      setAnnotations(result.annotations);
      setThreadTitles(result.threadTitles);
      setError(null);
    } catch (cause) {
      if (sequence !== refreshSequence.current) return;
      // Never leave actions enabled against a list the server failed to
      // verify. A successful later refresh replaces this empty snapshot.
      setAnnotations([]);
      setThreadTitles({});
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (sequence === refreshSequence.current) setIsLoading(false);
    }
  }, [rpc]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The toolbar's show/hide setting does not touch staging.
  useRealtime(
    "annotations",
    useCallback(
      (payload: unknown) => {
        if (broadcastType(payload) !== "config") void refresh();
      },
      [refresh],
    ),
  );

  // A submitted draft consumes its annotation pills; the server assigns those
  // annotations while resolving the mentions, so re-read the banner at once.
  useEffect(() => composer.onSubmitted(() => void refresh()), [composer, refresh]);

  // Append the pills after the draft's last word, as typing them there would.
  // Pills already in the draft are not repeated. The list returns focus to the
  // composer once it has closed.
  const mentionAnnotations = (items: readonly { id: string; label: string }[]) => {
    const { text, mentions } = composer.draft;
    const present = new Set(
      mentions.flatMap((mention) =>
        mention.kind === "plugin" &&
        mention.pluginId === pluginId &&
        mention.provider === ANNOTATION_MENTION_PROVIDER
          ? [mention.id]
          : [],
      ),
    );
    const parts = items
      .map((item) => ({ ...item, id: annotationMentionItemId(item.id, threadId) }))
      .filter((item) => !present.has(item.id))
      .flatMap((item) => [{ provider: ANNOTATION_MENTION_PROVIDER, ...item }, " "]);
    if (parts.length > 0) {
      const separator = text.length === 0 || /\s$/u.test(text) ? "" : " ";
      composer.insert([separator, ...parts], { at: "end" });
    }
  };

  // An annotation that left staging must leave the draft too, or its pill
  // would resolve against a record this thread already holds or dismissed.
  const forgetMentions = (annotationIds: readonly string[]) => {
    if (annotationIds.length === 0) return;
    const itemIds = new Set(annotationIds.map((id) => annotationMentionItemId(id, threadId)));
    composer.replace((current) => withoutAnnotationMentions(current, pluginId, itemIds));
  };

  const connection = useRealtimeConnectionState();
  const previousConnection = useRef(connection);
  useEffect(() => {
    if (previousConnection.current === "reconnecting" && connection === "connected") {
      void refresh();
    }
    previousConnection.current = connection;
  }, [connection, refresh]);

  const mentionAll = () =>
    mentionAnnotations(
      annotations.map((annotation) => ({
        id: annotation.id,
        label: annotationMentionLabel(
          annotation,
          annotationSourceLabel(annotation.bb, threadTitles),
        ),
      })),
    );

  const sendAnnotations = async (annotationIds: string[], sendingAnnotationId: string | null) => {
    if (actionInFlight.current || threadId === null) return;
    if (annotationIds.length === 0) return;

    actionInFlight.current = true;
    refreshSequence.current += 1;
    if (sendingAnnotationId === null) setIsSending(true);
    else setSendingId(sendingAnnotationId);
    try {
      const result = await rpc.call("sendStagedAnnotations", {
        annotationIds,
        threadId,
      });

      if (result.outcome === "sent") toast.success(result.message);
      else toast.warning(result.message);
      forgetMentions(result.sentIds);
      await refresh();
    } catch (cause) {
      toast.error(
        annotationIds.length === 1
          ? "Could not send the staged annotation"
          : "Could not send the staged annotations",
        {
          description: cause instanceof Error ? cause.message : String(cause),
        },
      );
      await refresh();
    } finally {
      if (sendingAnnotationId === null) setIsSending(false);
      else setSendingId(null);
      actionInFlight.current = false;
    }
  };

  const discardOne = async (annotation: StoredAnnotation) => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    refreshSequence.current += 1;
    setDiscardingId(annotation.id);
    try {
      const result = await rpc.call("discardStagedAnnotations", {
        annotationIds: [annotation.id],
      });
      if (result.outcome === "discarded") toast.success(result.message);
      else toast.warning(result.message);
      forgetMentions(result.discardedIds);
      await refresh();
    } catch (cause) {
      toast.error("Could not discard the staged annotation", {
        description: cause instanceof Error ? cause.message : String(cause),
      });
      await refresh();
    } finally {
      setDiscardingId(null);
      actionInFlight.current = false;
    }
  };

  const discardAll = async () => {
    if (actionInFlight.current || discardIds === null || discardIds.length === 0) {
      return;
    }

    actionInFlight.current = true;
    refreshSequence.current += 1;
    setIsDiscarding(true);
    try {
      const result = await rpc.call("discardStagedAnnotations", {
        annotationIds: discardIds,
      });
      if (result.outcome === "discarded") toast.success(result.message);
      else toast.warning(result.message);
      forgetMentions(result.discardedIds);
      await refresh();
      setDiscardIds(null);
    } catch (cause) {
      toast.error("Could not discard the staged annotations", {
        description: cause instanceof Error ? cause.message : String(cause),
      });
      await refresh();
      setDiscardIds(null);
    } finally {
      setIsDiscarding(false);
      actionInFlight.current = false;
    }
  };

  const openDiscardAll = () => {
    if (actionInFlight.current || annotations.length === 0) return;
    setDiscardIds(annotations.map((annotation) => annotation.id));
  };

  const closeDiscardAll = () => {
    if (isDiscarding) return;
    setDiscardIds(null);
  };

  if (isLoading || (annotations.length === 0 && error === null)) return null;

  const isMutating =
    isSending || sendingId !== null || discardingId !== null || isDiscarding || discardIds !== null;

  const sendAll = () =>
    void sendAnnotations(
      annotations.map((annotation) => annotation.id),
      null,
    );

  if (error) {
    return (
      <div data-agentation-staging-banner="" className="flex min-w-0 items-center gap-1.5">
        <span
          role="alert"
          title={error}
          className="inline-flex min-w-0 max-w-[320px] items-center gap-1 rounded-full border border-border bg-card px-2 py-1.5 text-sm text-destructive"
        >
          <Icon name="ChatFeedback" className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate pe-1 font-medium">Couldn't load annotations</span>
          <span className="sr-only">: {error}</span>
        </span>
        <Button type="button" size="sm" variant="ghost" onClick={() => void refresh()}>
          Retry
        </Button>
      </div>
    );
  }

  const rows = annotations.map((annotation) => {
    const location = annotationSourceLabel(annotation.bb, threadTitles);
    return {
      annotation,
      label: annotationMentionLabel(annotation, location),
      parts: { ...annotationMentionLabelParts(annotation, location), comment: annotation.comment },
    };
  });

  return (
    <>
      <div data-agentation-staging-banner="" className="flex min-w-0 max-w-full items-center">
        <AnnotationsPill
          count={annotations.length}
          disabled={isMutating}
          onDiscardAll={openDiscardAll}
          renderHeader={(dismiss) => (
            <div className="flex min-w-0 items-center justify-between gap-2 px-2.5 py-1.5">
              <p className="truncate text-xs font-medium text-muted-foreground">
                {annotationCountLabel(annotations.length)}
              </p>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2"
                  disabled={isMutating}
                  onClick={() => {
                    mentionAll();
                    dismiss(() => composer.focus());
                  }}
                >
                  <Icon name="AtSign" aria-hidden="true" />
                  Mention all
                </Button>
                {threadId === null ? null : (
                  <Button
                    type="button"
                    size="sm"
                    className="h-7 px-2"
                    disabled={isMutating}
                    onClick={sendAll}
                  >
                    <Icon name="ArrowUp" aria-hidden="true" />
                    {isSending ? "Sending…" : "Send all"}
                  </Button>
                )}
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="size-7 text-muted-foreground hover:text-destructive"
                  disabled={isMutating}
                  aria-label="Discard all staged annotations"
                  onClick={() => dismiss(openDiscardAll)}
                >
                  <Icon name="Trash2" aria-hidden="true" />
                </Button>
              </div>
            </div>
          )}
          renderList={(dismiss) => (
            <ol
              className="flex flex-col divide-y divide-border"
              aria-busy={isSending || sendingId !== null || discardingId !== null}
            >
              {rows.map(({ annotation, label, parts }, index) => (
                <AnnotationRow
                  key={annotation.id}
                  number={index + 1}
                  label={label}
                  parts={parts}
                  descriptionId={`${annotationDescriptionPrefix}-${annotation.id}`}
                  disabled={isMutating}
                  isSending={sendingId === annotation.id}
                  isDiscarding={discardingId === annotation.id}
                  onMention={() => {
                    mentionAnnotations([{ id: annotation.id, label }]);
                    dismiss(() => composer.focus());
                  }}
                  onSend={
                    threadId === null
                      ? null
                      : () => void sendAnnotations([annotation.id], annotation.id)
                  }
                  onDiscard={() => void discardOne(annotation)}
                />
              ))}
            </ol>
          )}
        />
      </div>

      <Dialog
        open={discardIds !== null}
        onOpenChange={(open) => {
          if (!open) closeDiscardAll();
        }}
      >
        <DialogContent>
          {discardIds !== null ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  Discard all {discardIds.length} staged annotation
                  {discardIds.length === 1 ? "" : "s"}?
                </DialogTitle>
                <DialogDescription>
                  This removes their markers from all bb pages and moves the feedback to the
                  Dismissed review view, where you can recover it.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  disabled={isDiscarding}
                  onClick={closeDiscardAll}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={isDiscarding || error !== null}
                  onClick={() => void discardAll()}
                >
                  {isDiscarding ? "Discarding…" : `Discard all ${discardIds.length}`}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function annotationCountLabel(count: number): string {
  return `${count} annotation${count === 1 ? "" : "s"}`;
}

// Matches the host's hover-card timing: brief enough to feel attached to the
// pill, long enough to cross the gap into the list.
const HOVER_CLOSE_DELAY_MS = 100;

/** Closes the list, then runs `after` once focus is free to move. */
type DismissList = (after?: () => void) => void;

/**
 * The staged batch as one composer attachment pill. A mouse hover previews
 * the list above the composer without taking focus; a click or keyboard
 * activation opens it for interaction. Its × discards the batch.
 */
function AnnotationsPill({
  count,
  disabled,
  renderHeader,
  renderList,
  onDiscardAll,
}: {
  count: number;
  disabled: boolean;
  renderHeader: (dismiss: DismissList) => ReactNode;
  renderList: (dismiss: DismissList) => ReactNode;
  onDiscardAll: () => void;
}) {
  const isCompact = useIsCompactViewport();
  const [open, setOpen] = useState(false);
  // "hover" previews follow the pointer and never move focus; "pinned" lists
  // came from a click or key and behave like an ordinary popover.
  const mode = useRef<"hover" | "pinned" | null>(null);
  const closeTimer = useRef<number | null>(null);
  // Set when the list closes for an action that decides where focus goes.
  const afterClose = useRef<(() => void) | null>(null);
  const restoreFocus = useRef(true);

  const cancelClose = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  useEffect(() => cancelClose, []);

  const changeOpen = (next: boolean) => {
    cancelClose();
    if (next) {
      mode.current ??= "pinned";
      restoreFocus.current = true;
    } else {
      // A preview never took focus, so it must not hand focus to the pill.
      if (mode.current === "hover") restoreFocus.current = false;
      mode.current = null;
    }
    setOpen(next);
  };
  const dismiss: DismissList = (after) => {
    afterClose.current = after ?? null;
    restoreFocus.current = false;
    mode.current = null;
    cancelClose();
    setOpen(false);
  };
  const runAfterClose = () => {
    const after = afterClose.current;
    afterClose.current = null;
    after?.();
  };

  // Compact windows show the list as a modal drawer, which opens by tap only.
  const isHover = (event: PointerEvent) => event.pointerType === "mouse" && !isCompact;
  const hoverOpen = (event: PointerEvent) => {
    if (!isHover(event)) return;
    cancelClose();
    if (open) return;
    mode.current = "hover";
    restoreFocus.current = false;
    setOpen(true);
  };
  const hoverClose = (event: PointerEvent) => {
    if (!isHover(event) || mode.current !== "hover") return;
    cancelClose();
    closeTimer.current = window.setTimeout(() => changeOpen(false), HOVER_CLOSE_DELAY_MS);
  };
  const label = annotationCountLabel(count);

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <div
        className="group relative inline-flex min-w-0 max-w-[320px]"
        onPointerEnter={hoverOpen}
        onPointerLeave={hoverClose}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            onClick={(event) => {
              // Clicking a hover preview pins it instead of closing it.
              if (open && mode.current === "hover") {
                event.preventDefault();
                cancelClose();
                mode.current = "pinned";
              }
            }}
            className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-border bg-card px-2 py-1.5 text-sm text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:pe-7"
          >
            <Icon
              name="ChatFeedback"
              className="size-3.5 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <span className="truncate pe-1 font-medium">{label}</span>
          </button>
        </PopoverTrigger>
        <button
          type="button"
          aria-label="Discard all staged annotations"
          disabled={disabled}
          onClick={() => dismiss(onDiscardAll)}
          className="pointer-events-none absolute top-1/2 right-1 flex size-5 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-card text-foreground opacity-0 transition-opacity before:pointer-events-none before:absolute before:inset-y-0 before:-left-6 before:right-full before:bg-linear-to-r before:from-transparent before:to-card before:content-[''] group-hover:pointer-events-auto group-hover:opacity-100 group-hover:before:to-accent hover:bg-accent focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-0 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100"
        >
          <Icon name="X" className="size-3" aria-hidden="true" />
        </button>
      </div>
      <PopoverContent
        side="top"
        align="start"
        mobileTitle={label}
        className={cn(
          "flex flex-col divide-y divide-border text-sm",
          !isCompact && "max-h-80 w-96 max-w-[calc(100vw-2rem)] overflow-y-auto p-0",
        )}
        onPointerEnter={hoverOpen}
        onPointerLeave={hoverClose}
        onOpenAutoFocus={(event) => {
          if (mode.current === "hover") event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          if (!restoreFocus.current) event.preventDefault();
          runAfterClose();
        }}
        onMobileContentAnimationEnd={(isOpen) => {
          if (!isOpen) runAfterClose();
        }}
      >
        {renderHeader(dismiss)}
        {renderList(dismiss)}
      </PopoverContent>
    </Popover>
  );
}

function AnnotationRow({
  number,
  label,
  parts,
  descriptionId,
  disabled,
  isSending,
  isDiscarding,
  onMention,
  onSend,
  onDiscard,
}: {
  number: number;
  label: string;
  parts: { location: string; target: string; comment: string };
  descriptionId: string;
  disabled: boolean;
  isSending: boolean;
  isDiscarding: boolean;
  onMention: () => void;
  onSend: (() => void) | null;
  onDiscard: () => void;
}) {
  const action = "size-7 shrink-0 text-muted-foreground hover:text-foreground";
  return (
    <li className="flex min-w-0 items-start gap-2 px-2.5 py-2">
      <span id={descriptionId} className="sr-only">
        {label}
      </span>
      <span className="shrink-0 pt-0.5 text-muted-foreground" aria-hidden="true">
        {number}.
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 pt-0.5" aria-hidden="true">
        <div className="flex min-w-0 items-center gap-1.5 text-xs leading-4 text-muted-foreground">
          <span className="inline-flex min-w-0 max-w-[60%] shrink-0 items-center rounded-sm border border-border bg-muted px-1.5 py-px font-mono text-[11px] leading-[14px] font-medium">
            <span className="truncate">{parts.target}</span>
          </span>
          <span className="min-w-0 truncate">{parts.location}</span>
        </div>
        <p className="break-words whitespace-pre-wrap text-foreground">{parts.comment}</p>
      </div>
      <div className="flex shrink-0 items-center">
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className={action}
          disabled={disabled}
          aria-label="Mention annotation in composer"
          aria-describedby={descriptionId}
          onClick={onMention}
        >
          <Icon name="AtSign" aria-hidden="true" />
        </Button>
        {onSend === null ? null : (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className={action}
            disabled={disabled}
            aria-label={
              isSending ? "Sending annotation to this thread" : "Send annotation to this thread"
            }
            aria-describedby={descriptionId}
            onClick={onSend}
          >
            <Icon
              name={isSending ? "Spinner" : "ArrowUp"}
              className={isSending ? "animate-spin" : undefined}
              aria-hidden="true"
            />
          </Button>
        )}
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
          disabled={disabled}
          aria-label={isDiscarding ? "Discarding annotation" : "Discard annotation"}
          aria-describedby={descriptionId}
          onClick={onDiscard}
        >
          <Icon
            name={isDiscarding ? "Spinner" : "Trash2"}
            className={isDiscarding ? "animate-spin" : undefined}
            aria-hidden="true"
          />
        </Button>
      </div>
    </li>
  );
}

export function AgentationStagingBanner() {
  const { scope } = useComposer();
  if (scope.kind === "thread") return <StagedAnnotations threadId={scope.threadId} />;
  if (scope.kind === "new-thread") return <StagedAnnotations threadId={null} />;
  return null;
}
