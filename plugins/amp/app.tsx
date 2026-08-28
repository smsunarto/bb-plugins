import "./app.css";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  experimental_useProviders,
  Markdown,
  useComposer,
  useComposerView,
  useRpc,
  type PluginMessageDirectiveProps,
  type PluginTimelineRendererProps,
} from "@get-bb/plugin-sdk/app";
import { isOracleReportId, ORACLE_DIRECTIVE_ID, type OracleReport } from "./src/oracle-directive";
import { AMP_LOGO_PATHS, AMP_LOGO_VIEW_BOX } from "./src/amp-brand";
import { AMP_AGENT } from "./src/execution-target";
import type { OrbUsageView } from "./src/orb-usage";
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

/** The Oracle report card. Two surfaces share it: the `amp/oracle` timeline
 *  renderer (new threads) and the legacy message directive (ACP-era threads,
 *  whose directives stay in their message bodies). */
function OracleCard({ reportId, question }: { reportId: string | undefined; question?: string }) {
  const rpc = useRpc<typeof rpcContract>();
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

function OracleDirective({ attributes }: PluginMessageDirectiveProps) {
  return <OracleCard reportId={attributes.reportId} />;
}

/** Body renderer for `amp/oracle` timeline items. The payload is the bridge's
 *  receipt, validated against the declared schema at ingest. */
function OracleTimelineItem({ payload }: PluginTimelineRendererProps) {
  const receipt =
    payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as { reportId?: unknown; question?: unknown })
      : {};
  return (
    <OracleCard
      question={typeof receipt.question === "string" ? receipt.question : undefined}
      reportId={typeof receipt.reportId === "string" ? receipt.reportId : undefined}
    />
  );
}

/** The thread-link state has no push channel to the app, so the banner polls
 *  `getOrbUsage` while a thread composer is mounted. */
const ORB_USAGE_POLL_MS = 5_000;

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

  useEffect(() => {
    if (threadId === null) return;
    const timer = setInterval(() => void refresh(), ORB_USAGE_POLL_MS);
    return () => clearInterval(timer);
  }, [refresh, threadId]);

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

/** True while this composer's model picker shows the Amp provider. The plugin
 *  composer view carries no selected-provider signal (SDK 0.4.21), so the gate
 *  reads the id-bearing markers the host paints into the picker trigger and
 *  compares them against Amp's directory record (`experimental_useProviders`).
 *  Two markers cover the trigger's two renders: the selected provider's icon
 *  as a `data-provider-logo=<logoUrl>` mask span, and the trigger label's
 *  `title="<displayName>: …"`, which is the only marker left when Fast mode
 *  swaps the icon for its Zap glyph. Titled nodes inside the toggle's own
 *  slot are ignored so the button cannot latch itself visible. Scoped to the
 *  surrounding `[data-app-composer]` so split panes gate independently; the
 *  picker's popover portals to <body>, so browsing other providers never
 *  flips the gate. The gate stays hidden until the directory is ready and
 *  hides outright when Amp has no record, because both mean the gate cannot
 *  tell which provider is selected and showing Orb on a Claude or Codex
 *  composer arms the next Amp thread from a button that has nothing to do
 *  with it. */
function useAmpComposerGate(): {
  setAnchor: (node: HTMLElement | null) => void;
  visible: boolean;
} {
  const providersState = experimental_useProviders();
  const ampProvider =
    providersState.providers.find((provider) => provider.id === AMP_AGENT.providerId) ?? null;
  const ampLogoUrl = ampProvider?.logoUrl ?? null;
  const ampDisplayName = ampProvider?.displayName ?? null;
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (anchor === null) return;
    // Not ready means the directory cannot say which provider is selected.
    // Returning without clearing left a previously-true `visible` standing
    // while the cleanup below had already disconnected the observer, so the
    // button survived on screen after the picker moved to another provider.
    if (providersState.status !== "ready") {
      setVisible(false);
      return;
    }
    // No Amp record means the provider is not registered, so there is no Amp
    // thread to arm. The old fail-open put the Orb button on a Claude or
    // Codex composer, and `status` is a three-way enum, so an "error"
    // directory reached it with Amp installed and registered.
    if (ampLogoUrl === null && ampDisplayName === null) {
      setVisible(false);
      return;
    }
    // Past the third plugin group the host portals composer actions into an
    // overflow popover on <body>, so the anchor has no composer ancestor.
    // Widen to the document rather than fail open: this action registers for
    // `new-thread` only and the host keeps at most one new-thread composer,
    // so the picker found here is still the one the button submits through.
    const composerRoot: ParentNode = anchor.closest("[data-app-composer]") ?? anchor.ownerDocument;
    const check = () => {
      const logoSelected =
        ampLogoUrl !== null &&
        Array.from(composerRoot.querySelectorAll("[data-provider-logo]")).some(
          (mark) => mark.getAttribute("data-provider-logo") === ampLogoUrl,
        );
      const titleSelected =
        ampDisplayName !== null &&
        Array.from(composerRoot.querySelectorAll("[title]")).some(
          (node) =>
            node.closest(".amp-orb-toggle-slot") === null &&
            (node.getAttribute("title") ?? "").startsWith(`${ampDisplayName}:`),
        );
      setVisible(logoSelected || titleSelected);
    };
    check();
    const observer = new MutationObserver(check);
    observer.observe(composerRoot instanceof Document ? composerRoot.body : composerRoot, {
      attributeFilter: ["data-provider-logo", "title"],
      attributes: true,
      childList: true,
      subtree: true,
    });
    return () => observer.disconnect();
  }, [anchor, ampLogoUrl, ampDisplayName, providersState.status]);
  return { setAnchor, visible };
}

/** New-thread composer action, rendered only while Amp is the selected
 *  provider (useAmpComposerGate); the wrapper span stays mounted as the
 *  gate's DOM anchor while the button unmounts. Pressing it arms a one-shot
 *  Orb intent on the server; nothing is typed into the draft. The bridge
 *  consumes the intent when the next thread starts, so the armed state
 *  lives server-side, and every remount re-reads it. Nothing here disarms on
 *  the way off Amp: the read makes a returning armed intent visible before
 *  the user can send, which is all the removed disarm bought, and it cost
 *  the arm whenever the host repainted the picker markers. The intent's own
 *  10-minute expiry bounds the rest. */
function OrbToggleAction() {
  const composer = useComposer();
  const view = useComposerView();
  const gate = useAmpComposerGate();
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
    wasVisible.current = gate.visible;
    if (gate.visible === was || !gate.visible) return;
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
  }, [gate.visible, rpc]);
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
  return (
    <span className="amp-orb-toggle-slot" ref={gate.setAnchor}>
      {gate.visible ? (
        <button
          aria-pressed={pressed}
          className="amp-orb-toggle"
          disabled={view.run.isSubmitting}
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
      ) : null}
    </span>
  );
}

export default definePluginApp((app) => {
  // The composer-action slot has no selected-provider signal, so the toggle
  // gates itself on the host DOM (useAmpComposerGate). It stays scoped to new
  // threads: the Orb flip is first-prompt-only, and the thread-scope banner
  // above covers the rest.
  app.composer.customize({
    id: "orb-toggle",
    scopes: ["new-thread"],
    actions: [{ id: "orb-toggle", component: OrbToggleAction }],
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
});
