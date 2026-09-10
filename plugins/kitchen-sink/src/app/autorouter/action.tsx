import { useRpc, useSettings } from "@get-bb/plugin-sdk/app";
import { useRef, useState } from "react";
import type { AutorouterRpcContract } from "../../shared/autorouter/contract.ts";
import { useRouting } from "./use-routing.ts";
import { RoutingNotice } from "./notice.tsx";
import "./autorouter.css";

export function AutorouterAction() {
  const { values, isLoading } = useSettings();
  const rpc = useRpc<AutorouterRpcContract>();
  const root = useRef<HTMLSpanElement>(null);
  const enabled = values?.autorouterEnabled === true;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = `${enabled ? "Disable" : "Enable"} autorouter`;
  const status = useRouting(root, enabled);
  const notice = error ?? status.message;
  const hasError = Boolean(error) || status.error;
  const showNotice = hasError || status.busy;

  async function toggle() {
    setPending(true);
    setError(null);
    try {
      await rpc.call("updateAutorouterEnabled", { enabled: !enabled });
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not save the autorouter setting.");
    } finally {
      setPending(false);
    }
  }

  return (
    <span
      ref={root}
      className="autorouter-action"
      data-autorouter-status={status.busy ? "routing" : status.error ? "error" : "ready"}
    >
      <button
        type="button"
        className="autorouter-toggle"
        aria-label={label}
        aria-pressed={enabled}
        aria-busy={status.busy}
        title={
          error ??
          (status.message ||
            `${label}: new-thread project/model routing and Astra follow-up reasoning`)
        }
        disabled={isLoading || pending || status.busy}
        onClick={() => void toggle()}
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
      {showNotice ? <RoutingNotice anchor={root} message={notice} error={hasError} /> : null}
    </span>
  );
}
