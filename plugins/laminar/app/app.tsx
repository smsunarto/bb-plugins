import "./app.css";
import { definePluginApp, useSettings } from "@get-bb/plugin-sdk/app";
import { useEffect, useState } from "react";
import { DEFAULT_LAMINAR_DASHBOARD_URL } from "../shared/settings.ts";
import {
  prepareRemoteSession,
  requiresConnectSession,
  type RemoteSessionState,
} from "./remote-session.ts";

function dashboardUrl(value: string | boolean | undefined): string {
  if (typeof value !== "string") return DEFAULT_LAMINAR_DASHBOARD_URL;

  try {
    const url = new URL(value.trim());
    if (url.protocol === "http:" || url.protocol === "https:") return url.toString();
  } catch {
    // The settings page owns validation feedback. Keep the panel usable here.
  }

  return DEFAULT_LAMINAR_DASHBOARD_URL;
}

function LaminarDashboard() {
  const { values } = useSettings();
  const src = dashboardUrl(values?.dashboardUrl);
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

  return (
    <div className="laminar-dashboard">
      {sessionState === "ready" ? (
        <>
          {/* oxlint-disable react/iframe-missing-sandbox -- Laminar needs scripts and access to its own origin for authentication. */}
          <iframe
            allow="clipboard-read; clipboard-write"
            referrerPolicy="same-origin"
            sandbox="allow-downloads allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"
            src={src}
            title="Laminar dashboard"
          />
          {/* oxlint-enable react/iframe-missing-sandbox */}
        </>
      ) : (
        <div className="laminar-dashboard-state">
          {sessionState === "preparing" ? (
            <>
              <div aria-hidden="true" className="laminar-dashboard-spinner" />
              <p>Preparing Laminar…</p>
            </>
          ) : (
            <>
              <div>
                <h2>Sign in to Laminar</h2>
                <p>Open the dashboard once, then return here and try again.</p>
              </div>
              <div className="laminar-dashboard-actions">
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
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "dashboard",
    title: "Laminar",
    icon: "ActivitySpark",
    path: "dashboard",
    component: LaminarDashboard,
  });
});
