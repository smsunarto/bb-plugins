import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  useComposer,
  useComposerView,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import type { StoredAnnotation } from "@/lib/afs.ts";
import {
  annotationMentionItemId,
  annotationMentionLabel,
  annotationMentionLabelParts,
  annotationSourceLabel,
} from "@/lib/staging-display.ts";
import type { rpcContract } from "@/server.ts";

function MentionAnnotationButton({
  annotation,
  descriptionId,
  disabled,
  location,
  threadId,
}: {
  annotation: StoredAnnotation;
  descriptionId: string;
  disabled: boolean;
  location: string;
  threadId: string;
}) {
  const composer = useComposer();

  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
      disabled={disabled}
      aria-label="Mention annotation in composer"
      aria-describedby={descriptionId}
      onClick={() => {
        composer.insertMention({
          provider: "annotation",
          id: annotationMentionItemId(annotation.id, threadId),
          label: annotationMentionLabel(annotation, location),
        });
        composer.focus();
      }}
    >
      <Icon name="AtSign" aria-hidden="true" />
    </Button>
  );
}

function StagedAnnotations({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
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
  const discardAllTriggerRef = useRef<HTMLButtonElement>(null);
  const annotationDescriptionPrefix = useId();

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    try {
      const result = await rpc.call("listStagedAnnotations");
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

  useRealtime(
    "annotations",
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  const connection = useRealtimeConnectionState();
  const previousConnection = useRef(connection);
  useEffect(() => {
    if (previousConnection.current === "reconnecting" && connection === "connected") {
      void refresh();
    }
    previousConnection.current = connection;
  }, [connection, refresh]);

  const sendAnnotations = async (annotationIds: string[], sendingAnnotationId: string | null) => {
    if (actionInFlight.current) return;
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
  const stagedLabel = `${annotations.length} staged`;

  return (
    <>
      {/* Bare composer banners use a display:contents host wrapper, so the
          component owns its gap from the native thread-context control below. */}
      <section
        className="mb-2 rounded-lg border border-border bg-card px-2 py-1"
        aria-label="Staged annotations"
      >
        <div className="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1">
          <div className="mr-auto flex min-w-0 items-center gap-2">
            <Icon
              name="ChatFeedback"
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <p className="truncate text-sm font-medium text-foreground">Annotations</p>
            <span
              className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
              aria-label={
                error && annotations.length === 0
                  ? "Staged annotation count unavailable"
                  : `${stagedLabel} annotation${annotations.length === 1 ? "" : "s"}`
              }
            >
              {error && annotations.length === 0 ? "Unavailable" : stagedLabel}
            </span>
          </div>

          <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-1.5">
            {annotations.length > 1 ? (
              <Button
                ref={discardAllTriggerRef}
                type="button"
                size="sm"
                variant="ghost"
                disabled={isMutating}
                onClick={openDiscardAll}
              >
                Discard all
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              disabled={isMutating}
              onClick={() =>
                error && annotations.length === 0
                  ? void refresh()
                  : void sendAnnotations(
                      annotations.map((annotation) => annotation.id),
                      null,
                    )
              }
            >
              {error && annotations.length === 0 ? null : isSending ? (
                <Icon name="Spinner" className="motion-safe:animate-spin" aria-hidden="true" />
              ) : (
                <Icon name="ArrowUp" aria-hidden="true" />
              )}
              {error && annotations.length === 0
                ? "Retry"
                : isSending
                  ? "Sending…"
                  : "Send to thread"}
            </Button>
          </div>
        </div>

        {error ? (
          <div
            className="mt-1 grid min-h-8 min-w-0 grid-cols-[1rem_minmax(0,1fr)] items-center gap-2 rounded-md bg-muted px-1.5 py-1 text-xs text-destructive"
            role="alert"
          >
            <Icon name="CircleX" className="size-4" aria-hidden="true" />
            <p className="min-w-0 break-words">{error}</p>
          </div>
        ) : (
          <ul
            className="mt-1 max-h-40 space-y-0.5 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]"
            aria-label="Feedback ready to send"
            aria-busy={isSending || sendingId !== null || discardingId !== null}
          >
            {annotations.map((annotation) => {
              const isSendingAnnotation = sendingId === annotation.id;
              const isDiscardingAnnotation = discardingId === annotation.id;
              const location = annotationSourceLabel(annotation.bb, threadTitles);
              const label = annotationMentionLabel(annotation, location);
              const labelParts = annotationMentionLabelParts(annotation, location);
              return (
                <li
                  key={annotation.id}
                  className="grid min-h-8 min-w-0 grid-cols-[1rem_minmax(0,1fr)_2rem_2rem_2rem] items-center gap-1 rounded-md bg-muted px-1.5 text-xs"
                >
                  <span id={`${annotationDescriptionPrefix}-${annotation.id}`} className="sr-only">
                    {label}
                  </span>
                  <span
                    className="flex size-4 items-center justify-center"
                    aria-hidden="true"
                  >
                    <span className="size-1.5 rounded-full bg-muted-foreground" />
                  </span>
                  <div className="min-w-0 leading-4" aria-hidden="true">
                    <p className="truncate text-sm text-foreground" title={labelParts.comment}>
                      {labelParts.comment}
                    </p>
                    <p
                      className="truncate text-xs text-muted-foreground"
                      title={`${labelParts.location} · ${labelParts.target}`}
                    >
                      {labelParts.location}
                      <span className="px-1">·</span>
                      {labelParts.target}
                    </p>
                  </div>
                  <MentionAnnotationButton
                    annotation={annotation}
                    descriptionId={`${annotationDescriptionPrefix}-${annotation.id}`}
                    disabled={isMutating}
                    location={location}
                    threadId={threadId}
                  />
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
                    disabled={isMutating}
                    aria-label={
                      isSendingAnnotation
                        ? "Sending annotation to this thread"
                        : "Send annotation to this thread"
                    }
                    aria-describedby={`${annotationDescriptionPrefix}-${annotation.id}`}
                    onClick={() => void sendAnnotations([annotation.id], annotation.id)}
                  >
                    <Icon
                      name={isSendingAnnotation ? "Spinner" : "ArrowUp"}
                      className={isSendingAnnotation ? "animate-spin" : undefined}
                      aria-hidden="true"
                    />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                    disabled={isMutating}
                    aria-label={
                      isDiscardingAnnotation ? "Discarding annotation" : "Discard annotation"
                    }
                    aria-describedby={`${annotationDescriptionPrefix}-${annotation.id}`}
                    onClick={() => void discardOne(annotation)}
                  >
                    <Icon
                      name={isDiscardingAnnotation ? "Spinner" : "Trash2"}
                      className={
                        isDiscardingAnnotation ? "motion-safe:animate-spin" : undefined
                      }
                      aria-hidden="true"
                    />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <Dialog
        open={discardIds !== null}
        onOpenChange={(open) => {
          if (!open) closeDiscardAll();
        }}
      >
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            setTimeout(() => discardAllTriggerRef.current?.focus(), 0);
          }}
        >
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

export function AgentationStagingBanner() {
  const view = useComposerView();
  if (view.scope.kind !== "thread") return null;

  return <StagedAnnotations threadId={view.scope.threadId} />;
}
