import { useRpc, useSettings } from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import type { AutorouterRpcContract } from "../../shared/autorouter/contract.ts";
import "./autorouter.css";

export function AutorouterAction() {
  const { values, isLoading } = useSettings();
  const rpc = useRpc<AutorouterRpcContract>();
  const enabled = values?.autorouterEnabled === true;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = `${enabled ? "Disable" : "Enable"} autorouter`;

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
    <span className="autorouter-action">
      <button
        type="button"
        className="autorouter-toggle"
        aria-label={label}
        aria-pressed={enabled}
        title={error ?? `${label}: project, model, and reasoning`}
        disabled={isLoading || pending}
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
      {error ? (
        <span className="autorouter-error" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}
