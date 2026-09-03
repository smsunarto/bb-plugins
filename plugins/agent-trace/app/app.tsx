import "./app.css";
import { definePluginApp, useSettings } from "@get-bb/plugin-sdk/app";
import { useEffect, useState } from "react";
import { DEFAULT_LANGFUSE_BASE_URL } from "../shared/settings.ts";
import {
  prepareRemoteSession,
  requiresConnectSession,
  type RemoteSessionState,
} from "./remote-session.ts";

function httpUrl(value: string | boolean | undefined): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol === "http:" || url.protocol === "https:") return url.toString();
  } catch {
    // The settings page owns validation feedback. Keep the panel usable here.
  }
  return null;
}

function EmbeddedDashboard({ src }: { src: string }) {
  const connectProtected = requiresConnectSession(src);
  const [attempt, setAttempt] = useState(0);
  const [sessionState, setSessionState] = useState<RemoteSessionState | "preparing">(
    connectProtected ? "preparing" : "ready",
  );

  useEffect(() => {
    let cancelled = false;
    if (!connectProtected) {
      setSessionState("ready");
      return;
    }

    setSessionState("preparing");
    void (async () => {
      const next = await prepareRemoteSession();
      if (!cancelled) setSessionState(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [attempt, connectProtected, src]);

  if (sessionState === "ready") {
    return (
      <>
        {/* oxlint-disable react/iframe-missing-sandbox -- The dashboard needs scripts and access to its own origin for authentication. */}
        <iframe
          allow="clipboard-read; clipboard-write"
          referrerPolicy="same-origin"
          sandbox="allow-downloads allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"
          src={src}
          title="Trace dashboard"
        />
        {/* oxlint-enable react/iframe-missing-sandbox */}
      </>
    );
  }

  return (
    <div className="agent-trace-dashboard-state">
      {sessionState === "preparing" ? (
        <>
          <div aria-hidden="true" className="agent-trace-dashboard-spinner" />
          <p>Preparing dashboard…</p>
        </>
      ) : (
        <>
          <div>
            <h2>Sign in to the dashboard</h2>
            <p>Open the dashboard once, then return here and try again.</p>
          </div>
          <div className="agent-trace-dashboard-actions">
            <a href={src} rel="noreferrer" target="_blank">
              Open dashboard
            </a>
            <button onClick={() => setAttempt((value) => value + 1)} type="button">
              Try again
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function TraceDashboard() {
  const { values } = useSettings();
  const embedded = httpUrl(values?.dashboardUrl);
  const langfuseConfigured =
    typeof values?.langfusePublicKey === "string" && values.langfusePublicKey.trim() !== "";
  const langfuseUrl = httpUrl(values?.langfuseBaseUrl) ?? DEFAULT_LANGFUSE_BASE_URL;

  return (
    <div className="agent-trace-dashboard">
      {embedded !== null ? (
        <EmbeddedDashboard src={embedded} />
      ) : (
        <div className="agent-trace-dashboard-state">
          <div>
            <h2>Agent Trace</h2>
            <p>
              Set an embedded dashboard URL in plugin settings, or open your trace backend directly.
            </p>
          </div>
          <div className="agent-trace-dashboard-actions">
            {langfuseConfigured ? (
              <a href={langfuseUrl} rel="noreferrer" target="_blank">
                Open Langfuse
              </a>
            ) : null}
            <a href="https://www.lmnr.ai" rel="noreferrer" target="_blank">
              Open Laminar
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "dashboard",
    title: "Agent Trace",
    icon: "ActivitySpark",
    path: "dashboard",
    component: TraceDashboard,
  });
});
