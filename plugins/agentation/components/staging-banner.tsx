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
}: {
  annotation: StoredAnnotation;
  descriptionId: string;
  disabled: boolean;
  location: string;
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
          id: annotation.id,
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

  return (
    <>
      <div className="min-w-0 max-w-full rounded-lg border border-border bg-card px-3 pb-3 pt-2">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Icon
                name="ChatFeedback"
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <p className="text-sm font-medium text-foreground">Annotations</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 sm:shrink-0 sm:justify-end">
            {annotations.length > 0 ? (
              <Button
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
              {error && annotations.length === 0 ? null : (
                <Icon name="ArrowUp" aria-hidden="true" />
              )}
              {error && annotations.length === 0 ? "Retry" : isSending ? "Sending…" : "Send all"}
            </Button>
          </div>
        </div>

        {error ? (
          <p className="mt-2 text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : (
          <ul
            className="mt-2 max-h-40 space-y-1 overflow-x-hidden overflow-y-auto border-t border-border pt-2"
            aria-busy={isSending || sendingId !== null || discardingId !== null}
          >
            {annotations.map((annotation) => {
              const isSendingAnnotation = sendingId === annotation.id;
              const isDiscardingAnnotation = discardingId === annotation.id;
              const location = annotationSourceLabel(annotation.bb, threadTitles);
              const label = annotationMentionLabel(annotation, location);
              const labelParts = annotationMentionLabelParts(annotation, location);
              return (
                <li key={annotation.id} className="flex w-full min-w-0 items-center gap-2 text-xs">
                  <span id={`${annotationDescriptionPrefix}-${annotation.id}`} className="sr-only">
                    {label}
                  </span>
                  <span
                    className="flex min-w-0 flex-1 items-baseline gap-1.5 overflow-hidden"
                    aria-hidden="true"
                  >
                    <span className="max-w-[30%] shrink-0 truncate text-muted-foreground">
                      [{labelParts.location}]
                    </span>
                    <span className="max-w-[30%] shrink-0 truncate font-mono text-[11px] text-foreground/80">
                      {labelParts.target}
                    </span>
                    <span className="shrink-0 text-muted-foreground/50">→</span>
                    <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                      {labelParts.comment}
                    </span>
                  </span>
                  <MentionAnnotationButton
                    annotation={annotation}
                    descriptionId={`${annotationDescriptionPrefix}-${annotation.id}`}
                    disabled={isMutating}
                    location={location}
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
                    className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                    disabled={isMutating}
                    aria-label={
                      isDiscardingAnnotation ? "Discarding annotation" : "Discard annotation"
                    }
                    aria-describedby={`${annotationDescriptionPrefix}-${annotation.id}`}
                    onClick={() => void discardOne(annotation)}
                  >
                    <Icon
                      name={isDiscardingAnnotation ? "Spinner" : "Trash2"}
                      className={isDiscardingAnnotation ? "animate-spin" : undefined}
                      aria-hidden="true"
                    />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
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

export function AgentationStagingBanner() {
  const view = useComposerView();
  if (view.scope.kind !== "thread") return null;

  return <StagedAnnotations threadId={view.scope.threadId} />;
}
