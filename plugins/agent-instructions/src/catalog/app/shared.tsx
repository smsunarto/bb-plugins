import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { Alert, AlertDescription } from "../../../components/ui/alert.tsx";
import { Button } from "../../../components/ui/button.tsx";
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
      <Alert variant="destructive" role="alert">
        <AlertDescription>
          {verb ? `${verb}, but publishing did not finish` : "Publishing did not finish"}:{" "}
          {shown.error}
        </AlertDescription>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={publish.isPending}
            onClick={() => publish.mutate(null)}
          >
            {publish.isPending ? "Publishing…" : "Retry publish"}
          </Button>
        </div>
      </Alert>
    );
  }
  return (
    <>
      {verb !== null && shown.problems.length === 0 && (
        <output>
          <Alert variant="success" role="none">
            <AlertDescription>{verb}. Agents get it in their next session.</AlertDescription>
          </Alert>
        </output>
      )}
      {shown.problems.map((problem) => (
        <Alert key={problem} variant="destructive" role="none">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      ))}
      {shown.warnings.map((warning) => (
        <Alert key={warning} variant="warning" role="none">
          <AlertDescription>{warning}</AlertDescription>
        </Alert>
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
