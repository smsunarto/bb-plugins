import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { queryKey, useRpcMutation } from "../../app/rpc.ts";
import type { PublishOutcome } from "../contract.ts";

export function usePublish() {
  const client = useQueryClient();
  return useRpcMutation("publishCatalog", {
    onSettled: () => client.invalidateQueries({ queryKey: queryKey("catalog") }),
  });
}

export function PublishNotices({
  outcome,
  verb,
}: {
  outcome: PublishOutcome;
  verb: string | null;
}) {
  const publish = usePublish();
  const shown = publish.data ?? outcome;
  if (!shown.ok) {
    return (
      <div className="pe-notice pe-notice-row" data-tone="bad" role="alert">
        <span>
          {verb ? `${verb}, but publishing did not finish` : "Publishing did not finish"}:{" "}
          {shown.error}
        </span>
        <button
          type="button"
          className="pe-button"
          disabled={publish.isPending}
          onClick={() => publish.mutate(null)}
        >
          {publish.isPending ? "Publishing…" : "Retry publish"}
        </button>
      </div>
    );
  }
  return (
    <>
      {verb !== null && shown.problems.length === 0 && (
        <output className="pe-notice" data-tone="good">
          {verb}. Agents get it in their next session.
        </output>
      )}
      {shown.problems.map((problem) => (
        <p key={problem} className="pe-notice" data-tone="bad">
          {problem}
        </p>
      ))}
      {shown.warnings.map((warning) => (
        <p key={warning} className="pe-notice" data-tone="warn">
          {warning}
        </p>
      ))}
    </>
  );
}

export function errorsOf(result: {
  outcome: string;
  errors?: string[];
  message?: string;
}): string[] {
  return result.outcome === "invalid" ? (result.errors ?? []) : [result.message ?? "Not saved"];
}

export function useCatalogChange() {
  const client = useQueryClient();
  return useRpcMutation("changeCatalog", {
    onSettled: () => client.invalidateQueries({ queryKey: queryKey("catalog") }),
  });
}

export function useFocusOnMount<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => ref.current?.focus(), []);
  return ref;
}
