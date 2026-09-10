import { useSettings } from "@get-bb/plugin-sdk/app";
import { useRef, useState } from "react";
import { enabledRouteIds } from "../../shared/autorouter/policy.ts";
import { useRouting } from "./use-routing.ts";
import "./autorouter.css";

export function AutorouterAction() {
  const { values } = useSettings();
  const root = useRef<HTMLSpanElement>(null);
  const [paused, setPaused] = useState(false);
  const routes = enabledRouteIds(values ?? {});
  const masterEnabled = values?.autorouterEnabled === true;
  const modelRouting = values?.autorouterModelRouting !== false;
  const projectRouting = values?.autorouterProjectRouting !== false;
  const status = useRouting(root, masterEnabled && !paused, {
    modelRouting: modelRouting && routes.size > 0,
    projectRouting,
    followupRouting: modelRouting && [...routes].some((id) => id.startsWith("astra/")),
  });
  const visible = masterEnabled && status.applicable;
  const enabled = visible && !paused;
  const label = `${enabled ? "Disable" : "Enable"} autorouter`;

  return (
    <span
      ref={root}
      className="autorouter-action"
      data-autorouter-status={status.busy ? "routing" : status.error ? "error" : "ready"}
    >
      {visible ? (
        <button
          type="button"
          className="autorouter-toggle"
          aria-label={label}
          aria-pressed={enabled}
          aria-busy={status.busy}
          title={status.message || label}
          disabled={status.busy}
          onClick={() => setPaused((value) => !value)}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M6 20V10a4 4 0 0 1 4-4h8M14 2l4 4-4 4M6 14h8a4 4 0 0 1 4 4v2" />
            <circle cx="6" cy="20" r="2" />
            <path d="m15 17 3 3 3-3" />
          </svg>
        </button>
      ) : null}
      <span className="autorouter-status" role={status.error ? "alert" : "status"}>
        {status.message}
      </span>
    </span>
  );
}
