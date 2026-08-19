import "./app.css";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  Markdown,
  useComposerView,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  type PluginMessageDirectiveProps,
} from "@get-bb/plugin-sdk/app";
import { isOracleReportId, ORACLE_DIRECTIVE_ID, type OracleReport } from "./src/oracle-directive";
import { AMP_LOGO_PATHS, AMP_LOGO_VIEW_BOX } from "./src/amp-brand";
import { findOrbDirectiveRanges } from "./src/orb-directive";
import { ORB_USAGE_CHANNEL, type OrbUsageView } from "./src/orb-usage";
import type { rpcContract } from "./server";

type OracleState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; report: OracleReport };

function TraceList({ report }: { report: OracleReport }) {
  if (report.trace.length === 0) {
    return <div className="text-xs text-muted-foreground">Oracle is reasoning…</div>;
  }
  return (
    <ol className="space-y-2">
      {report.trace.map((event) => (
        <li key={event.id} className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2 text-xs">
          <span className="uppercase tracking-wide text-muted-foreground">{event.kind}</span>
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-foreground">
              <span className="truncate">{event.title}</span>
              {event.status && (
                <span
                  className={
                    event.status === "error" ? "text-destructive" : "text-muted-foreground"
                  }
                >
                  {event.status}
                </span>
              )}
            </div>
            {event.content && (
              <div className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words text-muted-foreground">
                {event.content}
              </div>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

function OracleDirective({ attributes }: PluginMessageDirectiveProps) {
  const rpc = useRpc<typeof rpcContract>();
  const reportId = attributes.reportId;
  const [state, setState] = useState<OracleState>({ kind: "loading" });

  useEffect(() => {
    if (!isOracleReportId(reportId)) {
      setState({ kind: "error", message: "The Oracle report reference is invalid." });
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastReport: OracleReport | null = null;
    const pollAgain = () => {
      if (!cancelled) timer = setTimeout(() => void load(), 750);
    };
    setState({ kind: "loading" });
    const load = async () => {
      try {
        const result = await rpc.call("getOracleReport", { reportId });
        if (cancelled) return;
        if (result.report === null) {
          if (lastReport?.status === "running") {
            pollAgain();
          } else {
            setState({
              kind: "error",
              message: result.error ?? "The Oracle report is unavailable.",
            });
          }
        } else {
          lastReport = result.report;
          setState({ kind: "ready", report: result.report });
          if (result.report.status === "running") pollAgain();
        }
      } catch {
        if (lastReport?.status === "running") {
          pollAgain();
        } else if (!cancelled) {
          setState({ kind: "error", message: "The Oracle report request failed." });
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [reportId, rpc]);

  if (state.kind !== "ready") {
    return (
      <div className="my-2 rounded-md border border-border bg-card px-3 py-2 text-sm text-muted-foreground">
        {state.kind === "loading" ? "Loading Oracle response…" : state.message}
      </div>
    );
  }

  const failed = state.report.status === "error";
  const running = state.report.status === "running";
  const request = state.report.request?.replaceAll(/\s+/g, " ").trim() || "Oracle response";

  return (
    <details className="group my-2 overflow-hidden rounded-md border border-border bg-card" open>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 select-none marker:hidden">
        <span aria-hidden="true" className="text-primary">
          ✦
        </span>
        <span className="shrink-0 text-sm font-medium text-foreground">Oracle</span>
        <span className="min-w-0 truncate text-xs text-muted-foreground" title={request}>
          {request}
        </span>
        {running && <span className="shrink-0 text-xs text-primary">Running…</span>}
        {failed && <span className="shrink-0 text-xs text-destructive">Failed</span>}
        <span
          aria-hidden="true"
          className="ml-auto text-muted-foreground transition-transform group-open:rotate-90"
        >
          ›
        </span>
      </summary>
      <div className="border-t border-border px-3 py-3">
        {running ? (
          <div>
            {state.report.trace.length > 0 && (
              <div className="mb-2 text-xs font-medium text-foreground">Live trace</div>
            )}
            <TraceList report={state.report} />
          </div>
        ) : (
          <>
            <Markdown content={state.report.response} />
            {state.report.trace.length > 0 && (
              <details className="mt-3 border-t border-border pt-3">
                <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                  Trace · {state.report.trace.length} events
                </summary>
                <div className="mt-3">
                  <TraceList report={state.report} />
                </div>
              </details>
            )}
          </>
        )}
      </div>
    </details>
  );
}

function isThreadSignal(value: unknown, threadId: string): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { threadId?: unknown }).threadId === threadId
  );
}

function AmpOrbBanner() {
  const view = useComposerView();
  const rpc = useRpc<typeof rpcContract>();
  const threadId = view.scope.kind === "thread" ? view.scope.threadId : null;
  const [usage, setUsage] = useState<OrbUsageView>({ state: "hidden" });
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const refreshSequence = useRef(0);
  const copyResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    if (threadId === null) return;
    const sequence = ++refreshSequence.current;
    try {
      const result = await rpc.call("getOrbUsage", { threadId });
      if (sequence === refreshSequence.current) setUsage(result);
    } catch {
      if (sequence === refreshSequence.current) setUsage({ state: "hidden" });
    }
  }, [rpc, threadId]);

  useEffect(() => {
    setUsage({ state: "hidden" });
    setCopyState("idle");
    void refresh();
    return () => {
      refreshSequence.current += 1;
    };
  }, [refresh]);

  useRealtime(
    ORB_USAGE_CHANNEL,
    useCallback(
      (payload) => {
        if (threadId !== null && isThreadSignal(payload, threadId)) void refresh();
      },
      [refresh, threadId],
    ),
  );

  const connection = useRealtimeConnectionState();
  const previousConnection = useRef(connection);
  useEffect(() => {
    if (previousConnection.current === "reconnecting" && connection === "connected") {
      void refresh();
    }
    previousConnection.current = connection;
  }, [connection, refresh]);

  useEffect(
    () => () => {
      if (copyResetTimer.current !== null) clearTimeout(copyResetTimer.current);
    },
    [],
  );

  if (threadId === null || usage.state === "hidden") return null;

  const copySyncCommand = async () => {
    if (usage.state !== "active") return;
    if (copyResetTimer.current !== null) clearTimeout(copyResetTimer.current);
    try {
      await navigator.clipboard.writeText(usage.syncCommand);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    copyResetTimer.current = setTimeout(() => setCopyState("idle"), 1_800);
  };

  return (
    <div className="mb-2 rounded-lg border border-border bg-card p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <svg aria-hidden="true" className="amp-orb-brand-logo" viewBox={AMP_LOGO_VIEW_BOX}>
            {AMP_LOGO_PATHS.map((path) => (
              <path d={path} fill="currentColor" key={path} />
            ))}
          </svg>
          <span className="shrink-0 text-sm font-medium text-foreground">Orb</span>
          <span
            className="truncate text-xs text-muted-foreground"
            title="Remote execution in an Amp-managed cloud sandbox"
          >
            Remote execution in an Amp-managed cloud sandbox
          </span>
        </div>

        <span
          aria-live="polite"
          className={`amp-orb-status-pill${usage.state === "starting" ? " amp-orb-status-pill-starting" : ""}`}
        >
          <span
            aria-hidden="true"
            className={usage.state === "starting" ? "amp-orb-status-spinner" : "amp-orb-status-dot"}
          />
          {usage.state === "active" ? "Active" : "Starting"}
        </span>
      </div>

      <div className="mt-2 flex min-w-0 items-stretch overflow-hidden rounded-md border border-border bg-background">
        <input
          aria-label="Amp sync command"
          className="min-w-0 flex-1 bg-transparent px-2.5 py-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground"
          placeholder="Waiting for the Amp thread ID…"
          readOnly
          title={usage.state === "active" ? usage.syncCommand : undefined}
          value={usage.state === "active" ? usage.syncCommand : ""}
        />
        <button
          aria-label="Copy Amp sync command"
          className="amp-orb-copy-button w-20 border-l border-border px-2.5 py-1.5 text-xs font-medium"
          disabled={usage.state !== "active"}
          onClick={() => void copySyncCommand()}
          type="button"
        >
          {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy"}
        </button>
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "orb-directive-effect",
    richText: {
      effects: [
        {
          id: "orb-directive",
          className: "amp-orb-directive-highlight",
          match: findOrbDirectiveRanges,
        },
      ],
    },
  });

  app.composer.customize({
    id: "orb-usage-banner",
    scopes: ["thread"],
    banners: [
      {
        id: "orb-usage",
        chrome: "bare",
        component: AmpOrbBanner,
      },
    ],
  });

  app.slots.messageDirective({
    id: ORACLE_DIRECTIVE_ID,
    component: OracleDirective,
  });
});
