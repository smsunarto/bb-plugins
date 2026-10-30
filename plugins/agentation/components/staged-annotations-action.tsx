import {
  type PointerEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal, flushSync } from "react-dom";
import {
  type ComposerMention,
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

type Batch =
  | { kind: "loading" }
  // `attempt` re-keys the alert so a retry that fails the same way is
  // announced again.
  | { kind: "failed"; error: string; attempt: number }
  | { kind: "ready"; annotations: StoredAnnotation[]; threadTitles: Record<string, string> };

/** The one thing the list is doing; a `send` with no id sends the whole batch. */
type Action =
  | null
  | { kind: "send"; id: string | null }
  | { kind: "discard"; id: string }
  | { kind: "confirm-discard"; ids: string[] }
  | { kind: "discarding"; ids: string[] };

/**
 * `threadId` is null in the new-thread composer: no thread exists to send to
 * yet, so sending mentions the annotations and submits the composer. The
 * dispatch that creates the thread assigns them.
 */
function StagedAnnotations({ threadId }: { threadId: string | null }) {
  const rpc = useRpc<typeof rpcContract>();
  const composer = useComposer();
  const pluginId = experimental_usePluginId();
  const [batch, setBatch] = useState<Batch>({ kind: "loading" });
  // The ref answers "is something already running?" before React re-renders
  // the disabled controls; the state copy is what the render reads.
  const actionRef = useRef<Action>(null);
  const [action, setActionState] = useState<Action>(null);
  const setAction = (next: Action) => {
    actionRef.current = next;
    setActionState(next);
  };
  const refreshSequence = useRef(0);
  const annotationDescriptionPrefix = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const chipSlot = useComposerContextSlot(anchor);

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    try {
      // Every thread composer in every pane shows this action; they share
      // one request per change.
      const result = await sharedRequest("listStagedAnnotations", () =>
        rpc.call("listStagedAnnotations"),
      );
      if (sequence !== refreshSequence.current) return;
      setBatch({
        kind: "ready",
        annotations: result.annotations,
        threadTitles: result.threadTitles,
      });
    } catch (cause) {
      if (sequence !== refreshSequence.current) return;
      const error = cause instanceof Error ? cause.message : String(cause);
      setBatch((previous) => ({
        kind: "failed",
        error,
        attempt: previous.kind === "failed" ? previous.attempt + 1 : 1,
      }));
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
    const present = annotationMentionIds(mentions, pluginId);
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

  // In a composer with a context row, the batch shows there as a chip beside
  // the draft's attachments; elsewhere it stays a button in the action row.
  const asChip = chipSlot !== null;
  const place = (content: ReactNode) => (
    <>
      <span ref={anchor} hidden data-composer-context-anchor={asChip ? "portaled" : ""} />
      {chipSlot === null || content === null
        ? content
        : createPortal(
            // Plugin styles apply only under this plugin's root marker.
            <span data-bb-plugin={pluginId} className="contents">
              {content}
            </span>,
            chipSlot,
          )}
    </>
  );

  if (batch.kind === "loading") return place(null);

  if (batch.kind === "failed") {
    return place(
      <span className="contents" title={`Couldn't load annotations: ${batch.error}`}>
        <Button
          type="button"
          variant="ghost"
          data-agentation-staging-action=""
          aria-label="Retry loading annotations"
          className={cn(asChip ? CHIP_CLASS : ACTION_BUTTON_CLASS, "text-destructive")}
          onClick={() => void refresh()}
        >
          <Icon name="ChatFeedback" className="size-4 shrink-0" aria-hidden="true" />
          <span className={asChip ? undefined : "text-xs font-medium"}>Retry</span>
        </Button>
        <span key={batch.attempt} role="alert" className="sr-only">
          Couldn't load annotations: {batch.error}
        </span>
      </span>,
    );
  }

  // Beside the composer's own chip for mentioned annotations, the chip holds
  // only the ones still waiting, so the two never count the same annotation.
  // The action-row button keeps them all, to send or discard with their pills.
  const mentioned = annotationMentionIds(composer.draft.mentions, pluginId);
  const waiting = asChip
    ? batch.annotations.filter(
        (annotation) => !mentioned.has(annotationMentionItemId(annotation.id, threadId)),
      )
    : batch.annotations;
  if (waiting.length === 0) return place(null);

  const rows = waiting.map((annotation) => {
    const location = annotationSourceLabel(annotation.bb, batch.threadTitles);
    return {
      id: annotation.id,
      label: annotationMentionLabel(annotation, location),
      parts: { ...annotationMentionLabelParts(annotation, location), comment: annotation.comment },
    };
  });

  const sendAnnotations = async (annotationIds: string[], sendingAnnotationId: string | null) => {
    if (actionRef.current) return;
    setAction({ kind: "send", id: sendingAnnotationId });
    refreshSequence.current += 1;
    try {
      if (threadId === null) {
        const selectedIds = new Set(annotationIds);
        // Submit checks the host editor's rendered readiness. Commit the pills
        // first so an initially empty composer is ready on this same click.
        flushSync(() => mentionAnnotations(rows.filter((row) => selectedIds.has(row.id))));
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
      setAction(null);
    }
  };

  const sendAll = () =>
    void sendAnnotations(
      rows.map((row) => row.id),
      null,
    );

  const discardOne = async (annotationId: string) => {
    if (actionRef.current) return;
    setAction({ kind: "discard", id: annotationId });
    refreshSequence.current += 1;
    try {
      const result = await rpc.call("discardStagedAnnotations", {
        annotationIds: [annotationId],
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
      setAction(null);
    }
  };

  const openDiscardAll = () => {
    if (actionRef.current) return;
    setAction({ kind: "confirm-discard", ids: rows.map((row) => row.id) });
  };

  const closeDiscardAll = () => {
    if (actionRef.current?.kind === "confirm-discard") setAction(null);
  };

  const discardAll = async () => {
    const confirmed = actionRef.current;
    if (confirmed?.kind !== "confirm-discard") return;
    setAction({ kind: "discarding", ids: confirmed.ids });
    refreshSequence.current += 1;
    try {
      const result = await rpc.call("discardStagedAnnotations", {
        annotationIds: confirmed.ids,
      });
      if (result.outcome === "discarded") toast.success(result.message);
      else toast.warning(result.message);
      forgetMentions(result.discardedIds);
      await refresh();
    } catch (cause) {
      toast.error("Could not discard the staged annotations", {
        description: cause instanceof Error ? cause.message : String(cause),
      });
      await refresh();
    } finally {
      setAction(null);
    }
  };

  const isMutating = action !== null;
  const discard =
    action?.kind === "confirm-discard" || action?.kind === "discarding" ? action : null;
  const isDiscarding = discard?.kind === "discarding";

  return place(
    <>
      <AnnotationsAction
        asChip={asChip}
        count={rows.length}
        renderHeader={(dismiss) => (
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 px-2.5 py-1.5">
            <p className="truncate text-xs font-medium text-muted-foreground">
              {annotationCountLabel(rows.length)}
            </p>
            <div className="flex min-w-0 flex-wrap items-center gap-1">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2"
                disabled={isMutating}
                onClick={() => {
                  mentionAnnotations(rows);
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
                {action?.kind === "send" && action.id === null ? "Sending…" : "Send all"}
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
            aria-busy={action !== null && action.kind !== "confirm-discard"}
          >
            {rows.map(({ id, label, parts }, index) => (
              <AnnotationRow
                key={id}
                number={index + 1}
                label={label}
                parts={parts}
                descriptionId={`${annotationDescriptionPrefix}-${id}`}
                disabled={isMutating}
                isSending={action?.kind === "send" && action.id === id}
                isDiscarding={action?.kind === "discard" && action.id === id}
                onMention={() => {
                  mentionAnnotations([{ id, label }]);
                  dismiss(() => composer.focus());
                }}
                onSend={threadId === null ? null : () => void sendAnnotations([id], id)}
                onDiscard={() => void discardOne(id)}
              />
            ))}
          </ol>
        )}
      />

      <Dialog
        open={discard !== null}
        onOpenChange={(open) => {
          if (!open) closeDiscardAll();
        }}
      >
        <DialogContent>
          {discard ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  Discard all {discard.ids.length} staged annotation
                  {discard.ids.length === 1 ? "" : "s"}?
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
                  disabled={isDiscarding}
                  onClick={() => void discardAll()}
                >
                  {isDiscarding ? "Discarding…" : `Discard all ${discard.ids.length}`}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>,
  );
}

/** Item ids of this plugin's annotation pills in a draft. */
function annotationMentionIds(mentions: readonly ComposerMention[], pluginId: string): Set<string> {
  return new Set(
    mentions.flatMap((mention) =>
      mention.kind === "plugin" &&
      mention.pluginId === pluginId &&
      mention.provider === ANNOTATION_MENTION_PROVIDER
        ? [mention.id]
        : [],
    ),
  );
}

/**
 * The composer's row of attachment-like chips, when its composer offers one
 * (`[data-composer-context-slot]` inside the `[data-promptbox]` form, as the
 * T3 Composer draws it). Followed as the composer switches layouts.
 */
function useComposerContextSlot(anchor: RefObject<HTMLElement | null>): HTMLElement | null {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const root = anchor.current?.closest("[data-promptbox]");
    if (!root) return;
    const find = () =>
      setSlot(root.querySelector<HTMLElement>("[data-composer-context-slot]") ?? null);
    find();
    const observer = new MutationObserver(find);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [anchor]);
  return slot;
}

// The host mounts each action in a 36px-high cell that clips overflow, so the
// button keeps one height on every pointer and leaves room for its focus ring.
const ACTION_BUTTON_CLASS = "mx-px h-8 shrink-0 px-2";

// Matches the composer's attachment chips: a 32px pill with a hairline edge.
const CHIP_CLASS =
  "h-8 shrink-0 gap-1.5 rounded-[10px] border border-[color-mix(in_srgb,var(--foreground)_10%,transparent)] bg-background px-2.5 text-[13px] font-normal text-foreground hover:bg-[color-mix(in_srgb,var(--foreground)_6%,var(--background))]";

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
  asChip,
  count,
  renderHeader,
  renderList,
}: {
  asChip: boolean;
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

  // Mentioning the last waiting annotation unmounts the chip before its list
  // finishes closing; run the pending step (focusing the composer) anyway.
  useEffect(() => () => runAfterClose(), []);

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
            asChip
              ? cn(CHIP_CLASS, "data-[state=open]:bg-state-active")
              : cn(
                  ACTION_BUTTON_CLASS,
                  "gap-1 text-muted-foreground data-[state=open]:bg-state-active data-[state=open]:text-foreground",
                ),
          )}
        >
          <Icon
            name="ChatFeedback"
            className={cn("size-4 shrink-0", asChip && "text-muted-foreground")}
            aria-hidden="true"
          />
          {asChip ? (
            <span aria-hidden="true">{label}</span>
          ) : (
            <span className="text-xs font-medium tabular-nums">{count}</span>
          )}
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
