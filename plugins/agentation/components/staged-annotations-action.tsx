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

import { Badge } from "@/components/ui/badge";
import { Button, CompactButton } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemMedia,
  ItemSeparator,
} from "@/components/ui/item";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { cn } from "@/lib/utils";
import { Icon } from "@bb-plugins/icons";
import type { StoredAnnotation } from "@/lib/afs.ts";
import {
  ANNOTATION_MENTION_PROVIDER,
  annotationMentionItemId,
  annotationMentionLabel,
  annotationMentionLabelParts,
  annotationSourceLabel,
  withoutAnnotationMentions,
  type AnnotationMentionLabelParts,
} from "@/lib/staging-display.ts";
import { broadcastType, sharedRequest } from "@/lib/shared-request.ts";
import type { rpcContract } from "@/server.ts";

type Batch =
  | { kind: "loading" }
  | { kind: "ready"; annotations: StoredAnnotation[]; threadTitles: Record<string, string> };

/** The one thing the list is doing; no id means the whole batch. */
type Action = null | { kind: "send" | "discard"; id: string | null };

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
  const anchor = useRef<HTMLSpanElement>(null);
  const chipSlot = useComposerContextSlot(anchor);

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    // Every thread composer in every pane shows this action; they share
    // one request per change.
    const result = await sharedRequest("listStagedAnnotations", () =>
      rpc.call("listStagedAnnotations"),
    ).catch(() => null);
    if (sequence !== refreshSequence.current) return;
    // An unreachable plugin server shows no chip. The next realtime change
    // or reconnect refreshes the batch and brings the chip back.
    setBatch(
      result === null
        ? { kind: "loading" }
        : { kind: "ready", annotations: result.annotations, threadTitles: result.threadTitles },
    );
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
      .flatMap((item) =>
        present.has(item.id) ? [] : [{ provider: ANNOTATION_MENTION_PROVIDER, ...item }, " "],
      );
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
            <span
              data-bb-plugin={pluginId}
              {...{ [`data-bb-plugin-scope-${pluginId}`]: "" }}
              className="contents"
            >
              {content}
            </span>,
            chipSlot,
          )}
    </>
  );

  if (batch.kind === "loading") return place(null);

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

  // Discarding is recoverable from the panel's Dismissed view, so neither a
  // row nor the whole batch asks first.
  const discardAnnotations = async (
    annotationIds: string[],
    discardingAnnotationId: string | null,
  ) => {
    if (actionRef.current) return;
    setAction({ kind: "discard", id: discardingAnnotationId });
    refreshSequence.current += 1;
    try {
      const result = await rpc.call("discardStagedAnnotations", { annotationIds });
      if (result.outcome === "discarded") toast.success(result.message);
      else toast.warning(result.message);
      forgetMentions(result.discardedIds);
      await refresh();
    } catch (cause) {
      toast.error(
        annotationIds.length === 1
          ? "Could not discard the staged annotation"
          : "Could not discard the staged annotations",
        {
          description: cause instanceof Error ? cause.message : String(cause),
        },
      );
      await refresh();
    } finally {
      setAction(null);
    }
  };

  return place(
    <AnnotationsAction
      asChip={asChip}
      rows={rows}
      action={action}
      canSendOne={threadId !== null}
      onMention={mentionAnnotations}
      onSend={sendAnnotations}
      onDiscard={discardAnnotations}
      onReturnFocus={() => composer.focus()}
    />,
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
// button keeps the 32px small size on every pointer and leaves room for its
// focus ring.
const ACTION_BUTTON_CLASS = "mx-px shrink-0";

// Matches the composer's attachment chips: a 32px pill with a hairline edge.
const CHIP_CLASS =
  "h-8 shrink-0 gap-1 rounded-[10px] border border-[color-mix(in_srgb,var(--foreground)_10%,transparent)] bg-background px-2 text-[13px] font-normal text-foreground hover:bg-[color-mix(in_srgb,var(--foreground)_6%,var(--background))]";

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
  ...content
}: AnnotationsActionContentProps & { asChip: boolean }) {
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
  const count = content.rows.length;
  const label = annotationCountLabel(count);

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size={asChip ? undefined : "sm"}
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
                  // The kit's ghost has no muted resting tone; its open state paints the fill.
                  "text-muted-foreground data-[state=open]:text-foreground",
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
            <Badge variant="count">{count}</Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        mobileTitle={label}
        className={cn(
          "flex flex-col text-sm",
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
        <AnnotationsActionContent {...content} label={label} dismiss={dismiss} />
      </PopoverContent>
    </Popover>
  );
}

type AnnotationsActionContentProps = {
  rows: readonly {
    id: string;
    label: string;
    parts: AnnotationMentionLabelParts;
  }[];
  action: Action;
  canSendOne: boolean;
  onMention: (items: readonly { id: string; label: string }[]) => void;
  onSend: (ids: string[], itemId: string | null) => Promise<void>;
  onDiscard: (ids: string[], itemId: string | null) => Promise<void>;
  onReturnFocus: () => void;
};

function AnnotationsActionContent({
  rows,
  action,
  canSendOne,
  onMention,
  onSend,
  onDiscard,
  onReturnFocus,
  label,
  dismiss,
}: AnnotationsActionContentProps & { label: string; dismiss: DismissList }) {
  const isMutating = action !== null;
  return (
    <>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 min-h-10 px-3 py-1">
        <p className="truncate text-xs font-medium text-muted-foreground">{label}</p>
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          <CompactButton
            type="button"
            size="sm"
            variant="ghost"
            disabled={isMutating}
            onClick={() => {
              onMention(rows);
              dismiss(onReturnFocus);
            }}
          >
            <Icon name="AtSign" aria-hidden="true" />
            Mention all
          </CompactButton>
          <CompactButton
            type="button"
            size="sm"
            disabled={isMutating}
            onClick={() =>
              onSend(
                rows.map((row) => row.id),
                null,
              )
            }
          >
            <Icon name="ArrowUp" aria-hidden="true" />
            {action?.kind === "send" && action.id === null ? "Sending…" : "Send all"}
          </CompactButton>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7 text-muted-foreground hover:text-destructive"
            disabled={isMutating}
            aria-label="Discard all staged annotations"
            onClick={() => {
              onDiscard(
                rows.map((row) => row.id),
                null,
              );
              dismiss(onReturnFocus);
            }}
          >
            <Icon name="Trash2" aria-hidden="true" />
          </Button>
        </div>
      </div>
      <Separator />
      <ItemGroup className="has-data-[size=xs]:gap-0" aria-busy={isMutating}>
        {rows.map(({ id, label, parts }, index) => (
          <AnnotationRow
            key={id}
            separated={index > 0}
            number={index + 1}
            label={label}
            parts={parts}
            disabled={isMutating}
            isSending={action?.kind === "send" && action.id === id}
            isDiscarding={action?.kind === "discard" && action.id === id}
            onMention={() => {
              onMention([{ id, label }]);
              dismiss(onReturnFocus);
            }}
            onSend={canSendOne ? () => void onSend([id], id) : null}
            onDiscard={() => void onDiscard([id], id)}
          />
        ))}
      </ItemGroup>
    </>
  );
}

function AnnotationRow({
  separated,
  number,
  label,
  parts,
  disabled,
  isSending,
  isDiscarding,
  onMention,
  onSend,
  onDiscard,
}: {
  separated: boolean;
  number: number;
  label: string;
  parts: AnnotationMentionLabelParts;
  disabled: boolean;
  isSending: boolean;
  isDiscarding: boolean;
  onMention: () => void;
  onSend: (() => void) | null;
  onDiscard: () => void;
}) {
  const descriptionId = useId();
  const action = "size-7 shrink-0 text-muted-foreground hover:text-foreground";
  return (
    <>
      {separated ? <ItemSeparator className="my-0" /> : null}
      {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- ItemGroup is a div with role="list", which cannot hold an <li>. */}
      <Item role="listitem" size="xs" className="min-w-0 flex-nowrap items-start">
        <span id={descriptionId} className="sr-only">
          {label}
        </span>
        <ItemMedia aria-hidden="true">
          <span className="pt-1 text-muted-foreground">{number}.</span>
        </ItemMedia>
        <ItemContent className="group-data-[size=xs]/item:gap-1" aria-hidden="true">
          <div className="flex min-w-0 items-center gap-2 pt-1 text-xs leading-4 text-muted-foreground">
            <Badge variant="secondary" className="min-w-0 max-w-[60%] shrink-0 font-mono">
              <span className="truncate">{parts.target}</span>
            </Badge>
            <span className="min-w-0 truncate">{parts.location}</span>
          </div>
          <p className="break-words whitespace-pre-wrap text-foreground">{parts.comment}</p>
        </ItemContent>
        <ItemActions className="shrink-0 gap-0">
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
              {isSending ? <Spinner /> : <Icon name="ArrowUp" aria-hidden="true" />}
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
            {isDiscarding ? <Spinner /> : <Icon name="Trash2" aria-hidden="true" />}
          </Button>
        </ItemActions>
      </Item>
    </>
  );
}

export function AgentationStagedAnnotationsAction() {
  const { scope } = useComposer();
  if (scope.kind === "thread") return <StagedAnnotations threadId={scope.threadId} />;
  if (scope.kind === "new-thread") return <StagedAnnotations threadId={null} />;
  return null;
}
