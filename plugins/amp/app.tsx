import "./app.css";
import { useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  experimental_copyToClipboard,
  Markdown,
  useComposer,
  useRpc,
  type PluginMessageDirectiveProps,
  type PluginTimelineRendererProps,
} from "@get-bb/plugin-sdk/app";
import { sentryAppTelemetry } from "@bb-plugins/sentry/app";
import { PLUGIN_TELEMETRY } from "./shared/telemetry";
import { ORACLE_DIRECTIVE_ID, type OracleReport } from "./src/oracle-directive";
import { useOracleReport } from "./src/oracle-report-cache";
import { useOrbUsage } from "./src/orb-usage-store";
import { AMP_LOGO_PATHS, AMP_LOGO_VIEW_BOX } from "./src/amp-brand";
import { AMP_AGENT } from "./src/execution-target";
import type { rpcContract } from "./server";

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

/** The Oracle report card. Two surfaces share it: the `amp/oracle` timeline
 *  renderer (new threads) and the legacy message directive (ACP-era threads,
 *  whose directives stay in their message bodies). The report lives on the
 *  host that ran the thread, so the server needs the thread to find it, and
 *  the thread's own changes say when a running report may have finished. */
function OracleCard({
  reportId,
  threadId,
  question,
}: {
  reportId: string | undefined;
  threadId: string;
  question?: string;
}) {
  const state = useOracleReport(reportId, threadId);

  if (state.kind !== "ready") {
    return (
      <div className="my-2 rounded-md border border-border bg-card px-3 py-2 text-sm text-muted-foreground">
        {state.kind === "loading" ? "Loading Oracle response…" : state.message}
      </div>
    );
  }

  const failed = state.report.status === "error";
  const running = state.report.status === "running";
  const request =
    (state.report.request ?? question)?.replaceAll(/\s+/g, " ").trim() || "Oracle response";

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

function OracleDirective({ attributes, message }: PluginMessageDirectiveProps) {
  return <OracleCard reportId={attributes.reportId} threadId={message.threadId} />;
}

/** Body renderer for `amp/oracle` timeline items. The payload is the bridge's
 *  receipt, validated against the declared schema at ingest. */
function OracleTimelineItem({ payload, thread }: PluginTimelineRendererProps) {
  const receipt =
    payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as { reportId?: unknown; question?: unknown })
      : {};
  return (
    <OracleCard
      question={typeof receipt.question === "string" ? receipt.question : undefined}
      reportId={typeof receipt.reportId === "string" ? receipt.reportId : undefined}
      threadId={thread.id}
    />
  );
}

function AmpOrbBanner() {
  const { scope } = useComposer();
  const threadId = scope.kind === "thread" ? scope.threadId : null;
  const usage = useOrbUsage(threadId);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const copyResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => setCopyState("idle"), [threadId]);

  useEffect(
    () => () => {
      if (copyResetTimer.current !== null) clearTimeout(copyResetTimer.current);
    },
    [],
  );

  if (threadId === null || usage === null) return null;
  if (usage.state === "hidden" || usage.state === "unlinked") return null;

  const copySyncCommand = async () => {
    if (usage.state !== "active") return;
    if (copyResetTimer.current !== null) clearTimeout(copyResetTimer.current);
    // bb's own writer: the native clipboard in bb Desktop, no focus or secure
    // origin needed. It resolves false instead of rejecting.
    const written = await experimental_copyToClipboard({ text: usage.syncCommand });
    setCopyState(written ? "copied" : "failed");
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

/** New-thread composer banner, rendered only while this composer's provider
 *  picker selects Amp. It is a banner rather than an action so that, while
 *  hidden, it does not hold one of bb's three inline action slots. The
 *  composer reports its own selection, so split panes each gate on their own
 *  composer, and an unresolved picker (no `providerId` yet) keeps the button off a Claude or
 *  Codex composer. Pressing it arms a one-shot Orb intent on the server;
 *  nothing is typed into the draft. The next Amp thread bb creates claims the
 *  intent, so the armed state lives server-side, and every reappearance
 *  re-reads it. Nothing here disarms on the way off Amp: the read makes a
 *  returning armed intent visible before the user can send. The intent's own
 *  10-minute expiry bounds the rest. */
function OrbToggleBanner() {
  const composer = useComposer();
  const visible = composer.selection?.providerId === AMP_AGENT.providerId;
  const rpc = useRpc<typeof rpcContract>();
  const [pressed, setPressed] = useState(false);
  const wasVisible = useRef(false);
  /** Bumped on every press. A `getOrbIntent` answer minted before the press
   *  describes the state that press replaced, so applying it late would read
   *  "off" while the server is armed, and the next thread would run on Orb
   *  with nothing on screen saying so. */
  const pressSeq = useRef(0);
  useEffect(() => {
    const was = wasVisible.current;
    wasVisible.current = visible;
    if (visible === was || !visible) return;
    let cancelled = false;
    const seq = pressSeq.current;
    void rpc
      .call("getOrbIntent", {})
      .then((result) => {
        if (!cancelled && seq === pressSeq.current) setPressed(result.armed);
        return null;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [visible, rpc]);
  const toggle = () => {
    const next = !pressed;
    pressSeq.current += 1;
    const seq = pressSeq.current;
    setPressed(next);
    void rpc.call("setOrbIntent", { armed: next }).catch(() => {
      // Roll back only while this press is still the latest one. A failure
      // that lands after two further presses would otherwise restore the
      // state its own press replaced, undoing what the user last asked for.
      if (seq === pressSeq.current) setPressed(!next);
    });
    composer.focus();
  };
  if (!visible) return null;
  return (
    <div className="mb-2 flex">
      <button
        aria-pressed={pressed}
        className="amp-orb-toggle"
        disabled={composer.isSubmitting}
        onClick={toggle}
        title="Run this thread in an Amp Orb cloud sandbox"
        type="button"
      >
        <svg aria-hidden="true" className="amp-orb-toggle-logo" viewBox={AMP_LOGO_VIEW_BOX}>
          {AMP_LOGO_PATHS.map((path) => (
            <path d={path} fill="currentColor" key={path} />
          ))}
        </svg>
        Orb
      </button>
    </div>
  );
}

const telemetry = sentryAppTelemetry(PLUGIN_TELEMETRY);

export default definePluginApp(
  telemetry.instrument((app) => {
    // The toggle gates itself on the composer's selected provider. It stays
    // scoped to new threads: the Orb flip is first-prompt-only, and the
    // thread-scope banner below covers the rest.
    app.composer.customize({
      id: "orb-toggle",
      scopes: ["new-thread"],
      banners: [{ id: "orb-toggle", chrome: "bare", component: OrbToggleBanner }],
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

    // AMP_ORACLE_KIND (src/bridge/shapes.ts). The app bundle must stay
    // node-free, so the literal repeats here rather than importing it.
    app.slots.experimental_timelineRenderer({
      kind: "amp/oracle",
      component: OracleTimelineItem,
    });

    // ACP-era threads carry Oracle results as message directives; keep their
    // renderer so history stays readable.
    app.slots.messageDirective({
      id: ORACLE_DIRECTIVE_ID,
      component: OracleDirective,
    });
  }),
);
