// The review panel: everything the toolbar collected, in one place.
//
// The toolbar is good at pointing at a thing and bad at reading a backlog, so
// the panel owns the other half — triage across pages, assignment state, and
// the reply thread associated with each annotation.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { rpcContract } from "@/server.ts";
import type {
  AnnotationRouting,
  AnnotationStatus,
  SessionSummary,
  StoredAnnotation,
} from "@/lib/afs.ts";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

const statusFilters = [
  { id: "open", label: "Open", statuses: ["pending", "acknowledged"] },
  { id: "resolved", label: "Resolved", statuses: ["resolved"] },
  { id: "dismissed", label: "Dismissed", statuses: ["dismissed"] },
  { id: "all", label: "All", statuses: null },
] as const;

type FilterId = (typeof statusFilters)[number]["id"];

const statusTone: Record<AnnotationStatus, string> = {
  pending: "text-foreground",
  acknowledged: "text-primary",
  resolved: "text-muted-foreground",
  dismissed: "text-muted-foreground",
};

function Pill({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border border-border px-2 py-0.5 text-[11px] leading-4 text-muted-foreground",
        className,
      )}
    >
      {children}
    </span>
  );
}

function useAnnotations(filter: FilterId) {
  const rpc = useRpc<typeof rpcContract>();
  const [annotations, setAnnotations] = useState<StoredAnnotation[]>([]);
  const [routings, setRoutings] = useState<Record<string, AnnotationRouting>>({});
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const statuses = useMemo(
    () => statusFilters.find((entry) => entry.id === filter)?.statuses ?? null,
    [filter],
  );

  const refresh = useCallback(async () => {
    try {
      const [annotationResult, sessionResult] = await Promise.all([
        rpc.call("listAnnotations", {
          sessionId: null,
          statuses: statuses ? [...statuses] : null,
          pluginId: null,
        }),
        rpc.call("listSessions", { status: null }),
      ]);
      setAnnotations(annotationResult.annotations);
      setRoutings(annotationResult.routings);
      setSessions(sessionResult.sessions);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsLoading(false);
    }
  }, [rpc, statuses]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useRealtime(
    "annotations",
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  return { annotations, routings, sessions, isLoading, error, refresh };
}

function AnnotationCard({
  annotation,
  routing,
  rpc,
  onChanged,
}: {
  annotation: StoredAnnotation;
  routing: AnnotationRouting | undefined;
  rpc: Rpc;
  onChanged: () => void;
}) {
  const navigate = useBbNavigate();
  const [reply, setReply] = useState("");
  const [isBusy, setIsBusy] = useState(false);

  const run = async (work: () => Promise<unknown>, failure: string) => {
    setIsBusy(true);
    try {
      await work();
      onChanged();
    } catch (cause) {
      toast.error(failure, {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setIsBusy(false);
    }
  };

  const mutate = (action: "acknowledge" | "resolve" | "dismiss" | "delete") =>
    run(
      () =>
        rpc.call("mutateAnnotation", {
          annotationId: annotation.id,
          action,
          note: null,
        }),
      `Could not ${action} the annotation`,
    );

  const isClosed = annotation.status === "resolved" || annotation.status === "dismissed";
  const isAssigned = routing?.state === "assigned" && routing.assignedThreadId !== null;

  return (
    <div className={cn("rounded-lg border border-border bg-card p-3", isClosed && "opacity-60")}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-xs text-foreground">{annotation.element}</span>
        <Pill className={statusTone[annotation.status]}>{annotation.status}</Pill>
        {routing ? (
          <Pill>
            {routing.state === "assigned" ? `assigned: ${routing.assignedThreadId}` : routing.state}
          </Pill>
        ) : null}
        {annotation.severity ? <Pill>{annotation.severity}</Pill> : null}
        {annotation.intent ? <Pill>{annotation.intent}</Pill> : null}
        <Pill>{annotation.bb.pluginId ? `plugin: ${annotation.bb.pluginId}` : "bb shell"}</Pill>
        {annotation.bb.surface ? <Pill>{annotation.bb.surface}</Pill> : null}
      </div>

      <p className="mt-2 text-sm text-foreground">{annotation.comment}</p>

      <dl className="mt-2 space-y-0.5 text-[11px] text-muted-foreground">
        <div className="truncate">
          <dt className="inline font-medium">Selector: </dt>
          <dd className="inline font-mono">{annotation.elementPath}</dd>
        </div>
        {annotation.reactComponents ? (
          <div className="truncate">
            <dt className="inline font-medium">React: </dt>
            <dd className="inline font-mono">{annotation.reactComponents}</dd>
          </div>
        ) : null}
        {annotation.sourceFile ? (
          <div className="truncate">
            <dt className="inline font-medium">Source: </dt>
            <dd className="inline font-mono">{annotation.sourceFile}</dd>
          </div>
        ) : null}
        {annotation.selectedText ? (
          <div className="truncate">
            <dt className="inline font-medium">Selected: </dt>
            <dd className="inline">“{annotation.selectedText}”</dd>
          </div>
        ) : null}
      </dl>

      {annotation.thread.length > 0 ? (
        <ul className="mt-2 space-y-1 border-l border-border pl-3">
          {annotation.thread.map((message) => (
            <li key={message.id} className="text-xs">
              <span
                className={cn(
                  "font-medium",
                  message.role === "agent" ? "text-primary" : "text-muted-foreground",
                )}
              >
                {message.role}
              </span>
              <span className="text-foreground"> {message.content}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {annotation.resolution ? (
        <p className="mt-2 text-xs text-muted-foreground">
          <span className="font-medium">Outcome:</span> {annotation.resolution}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {!isClosed ? (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={isBusy}
              onClick={() => void mutate("resolve")}
            >
              Resolve
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={isBusy}
              onClick={() => void mutate("dismiss")}
            >
              Dismiss
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={isBusy}
            onClick={() =>
              void run(
                () =>
                  rpc.call("mutateAnnotation", {
                    annotationId: annotation.id,
                    action: "reopen",
                    note: null,
                  }),
                "Could not reopen the annotation",
              )
            }
          >
            Reopen
          </Button>
        )}
        <Button size="sm" variant="ghost" disabled={isBusy} onClick={() => void mutate("delete")}>
          Delete
        </Button>
        {routing?.assignedThreadId ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => navigate.toThread(routing.assignedThreadId as string)}
          >
            Open assigned thread
          </Button>
        ) : null}
        {annotation.bb.threadId && annotation.bb.threadId !== routing?.assignedThreadId ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => navigate.toThread(annotation.bb.threadId as string)}
          >
            Open source thread
          </Button>
        ) : null}
        {!isClosed && isAssigned ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={isBusy}
            onClick={() =>
              void run(
                () =>
                  rpc.call("restageAnnotation", {
                    annotationId: annotation.id,
                  }),
                "Could not stage the annotation again",
              )
            }
          >
            Stage again
          </Button>
        ) : null}
      </div>

      <form
        className="mt-2 flex items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          const message = reply.trim();
          if (message.length === 0) return;
          void run(
            () =>
              rpc
                .call("replyToAnnotation", {
                  annotationId: annotation.id,
                  message,
                })
                .then(() => setReply("")),
            "Could not post the reply",
          );
        }}
      >
        <Input
          value={reply}
          placeholder={
            isAssigned
              ? "Reply in the assigned thread…"
              : "Send this annotation to a thread before replying"
          }
          className="h-8 text-xs"
          disabled={!isAssigned || isBusy}
          onChange={(event) => setReply(event.target.value)}
        />
        <Button
          size="sm"
          variant="outline"
          type="submit"
          disabled={!isAssigned || isBusy || reply.trim().length === 0}
        >
          Reply
        </Button>
      </form>
    </div>
  );
}

export function AnnotationPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const [filter, setFilter] = useState<FilterId>("open");
  const { annotations, routings, sessions, isLoading, error, refresh } = useAnnotations(filter);

  const grouped = useMemo(() => {
    const bySession = new Map<string, StoredAnnotation[]>();
    for (const annotation of annotations) {
      const bucket = bySession.get(annotation.sessionId);
      if (bucket) bucket.push(annotation);
      else bySession.set(annotation.sessionId, [annotation]);
    }
    return [...bySession.entries()];
  }, [annotations]);

  const sessionsById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions],
  );

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-4 p-4 md:p-5">
        <div className="flex flex-wrap items-center gap-1.5">
          {statusFilters.map((entry) => (
            <Button
              key={entry.id}
              size="sm"
              variant={filter === entry.id ? "secondary" : "ghost"}
              onClick={() => setFilter(entry.id)}
            >
              {entry.label}
            </Button>
          ))}
        </div>

        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : isLoading ? (
          <p className="text-sm text-muted-foreground">Loading annotations…</p>
        ) : grouped.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-6 text-center">
            <p className="text-sm text-foreground">No annotations here yet.</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Open the Agentation toolbar in the bottom-right corner of bb, click any element —
              including one drawn by a plugin — and describe what should change.
            </p>
          </div>
        ) : (
          grouped.map(([sessionId, sessionAnnotations]) => {
            const session = sessionsById.get(sessionId);
            return (
              <section key={sessionId} className="space-y-2">
                <header className="flex items-center justify-between gap-2">
                  <h2 className="truncate text-sm font-medium text-foreground">
                    {session?.route ?? sessionId}
                  </h2>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {sessionAnnotations.length} annotation
                    {sessionAnnotations.length === 1 ? "" : "s"}
                  </span>
                </header>
                <div className="space-y-2">
                  {sessionAnnotations.map((annotation) => (
                    <AnnotationCard
                      key={annotation.id}
                      annotation={annotation}
                      routing={routings[annotation.id]}
                      rpc={rpc}
                      onChanged={() => void refresh()}
                    />
                  ))}
                </div>
              </section>
            );
          })
        )}
      </div>
    </div>
  );
}

/** Rendered by the host into the shared panel title bar. */
export function AnnotationPanelHeader() {
  const rpc = useRpc<typeof rpcContract>();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [pending, setPending] = useState(0);

  const load = useCallback(async () => {
    try {
      const result = await rpc.call("getConfig");
      setEnabled(result.config.toolbarEnabled);
      setPending(result.counts.pending);
    } catch {
      setEnabled(null);
    }
  }, [rpc]);

  useEffect(() => {
    void load();
  }, [load]);

  useRealtime(
    "annotations",
    useCallback(() => {
      void load();
    }, [load]),
  );

  return (
    <div className="flex items-center gap-2">
      {pending > 0 ? <span className="text-xs text-muted-foreground">{pending} open</span> : null}
      <Button
        size="sm"
        variant="outline"
        disabled={enabled === null}
        onClick={() => {
          const next = !enabled;
          setEnabled(next);
          void rpc.call("setToolbarEnabled", { enabled: next }).catch((cause: unknown) => {
            setEnabled(!next);
            toast.error("Could not change the toolbar", {
              description: cause instanceof Error ? cause.message : String(cause),
            });
          });
        }}
      >
        {enabled === false ? "Show toolbar" : "Hide toolbar"}
      </Button>
    </div>
  );
}

/** Rendered under the declarative settings form on the plugin's detail page. */
export function AgentationSettingsSection() {
  return (
    <div className="space-y-2 text-sm text-muted-foreground">
      <p>
        The toolbar mounts over the whole bb app, so it can annotate the shell and any plugin
        surface. Elements drawn by a plugin are attributed to that plugin automatically.
      </p>
      <p>
        New annotations enter a shared staging area. Every open thread shows the staged batch above
        its composer, where you can assign the batch to that thread.
      </p>
      <p>
        Agents read assigned feedback with the <code>agentation_*</code> tools or{" "}
        <code>bb agentation pending</code>. Resolving an annotation removes its marker from every
        open bb window.
      </p>
    </div>
  );
}
