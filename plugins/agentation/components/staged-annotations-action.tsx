import {
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
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
 * yet, so sending mentions the annotations and submits the composer. The
 * dispatch that creates the thread assigns them.
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
  // Re-keys the alert so a retry that fails the same way is announced again.
  const [failures, setFailures] = useState(0);
  const refreshSequence = useRef(0);
  const actionInFlight = useRef(false);
  const annotationDescriptionPrefix = useId();

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    try {
      // Every thread composer in every pane shows this action; they share
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
      setFailures((count) => count + 1);
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
  // annotations while resolving the mentions, so re-read the list at once.
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
    if (actionInFlight.current) return;
    if (annotationIds.length === 0) return;

    actionInFlight.current = true;
    refreshSequence.current += 1;
    if (sendingAnnotationId === null) setIsSending(true);
    else setSendingId(sendingAnnotationId);
    try {
      if (threadId === null) {
        const selectedIds = new Set(annotationIds);
        // Submit checks the host editor's rendered readiness. Commit the pills
        // first so an initially empty composer is ready on this same click.
        flushSync(() =>
          mentionAnnotations(
            annotations
              .filter((annotation) => selectedIds.has(annotation.id))
              .map((annotation) => ({
                id: annotation.id,
                label: annotationMentionLabel(
                  annotation,
                  annotationSourceLabel(annotation.bb, threadTitles),
                ),
              })),
          ),
        );
        await composer.submit();
        await refresh();
        return;
      }
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
      <span className="contents" title={`Couldn't load annotations: ${error}`}>
        <Button
          type="button"
          variant="ghost"
          data-agentation-staging-action=""
          aria-label="Retry loading annotations"
          className={cn(ACTION_BUTTON_CLASS, "text-destructive")}
          onClick={() => void refresh()}
        >
          <Icon name="ChatFeedback" className="size-4 shrink-0" aria-hidden="true" />
          <span className="text-xs font-medium">Retry</span>
        </Button>
        <span key={failures} role="alert" className="sr-only">
          Couldn't load annotations: {error}
        </span>
      </span>
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
      <AnnotationsAction
        count={annotations.length}
        renderHeader={(dismiss) => (
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 px-2.5 py-1.5">
            <p className="truncate text-xs font-medium text-muted-foreground">
              {annotationCountLabel(annotations.length)}
            </p>
            <div className="flex min-w-0 flex-wrap items-center gap-1">
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

// The host mounts each action in a 36px-high cell that clips overflow, so the
// button keeps one height on every pointer and leaves room for its focus ring.
const ACTION_BUTTON_CLASS = "mx-px h-8 shrink-0 px-2";

function annotationCountLabel(count: number): string {
  return `${count} annotation${count === 1 ? "" : "s"}`;
}

// Matches the host's hover-card timing: brief enough to feel attached to the
// button, long enough to cross the gap into the list.
const HOVER_CLOSE_DELAY_MS = 100;

/** Closes the list, then runs `after` once focus is free to move. */
type DismissList = (after?: () => void) => void;

/**
 * The staged batch as one button in the composer's action row. A mouse hover
 * previews the list above the composer without taking focus; a click or
 * keyboard activation opens it for interaction.
 */
function AnnotationsAction({
  count,
  renderHeader,
  renderList,
}: {
  count: number;
  renderHeader: (dismiss: DismissList) => ReactNode;
  renderList: (dismiss: DismissList) => ReactNode;
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
      // A preview never took focus, so it must not hand focus to the button.
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
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          data-agentation-staging-action=""
          aria-label={label}
          onPointerEnter={hoverOpen}
          onPointerLeave={hoverClose}
          onClick={(event) => {
            // Clicking a hover preview pins it instead of closing it.
            if (open && mode.current === "hover") {
              event.preventDefault();
              cancelClose();
              mode.current = "pinned";
            }
          }}
          className={cn(
            ACTION_BUTTON_CLASS,
            "gap-1 text-muted-foreground data-[state=open]:bg-state-active data-[state=open]:text-foreground",
          )}
        >
          <Icon name="ChatFeedback" className="size-4 shrink-0" aria-hidden="true" />
          <span className="text-xs font-medium tabular-nums">{count}</span>
        </Button>
      </PopoverTrigger>
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

export function AgentationStagedAnnotationsAction() {
  const { scope } = useComposer();
  if (scope.kind === "thread") return <StagedAnnotations threadId={scope.threadId} />;
  if (scope.kind === "new-thread") return <StagedAnnotations threadId={null} />;
  return null;
}
