import { useRealtime } from "@get-bb/plugin-sdk/app";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { InfoOutput } from "../../shared/contracts/rpc.ts";
import { CHANNELS } from "../../shared/contracts/channels.ts";
import { Button } from "../components/ui/button.tsx";
import { EmptyState } from "../panel/empty-state.tsx";
import { queryClient } from "../query.ts";
import { queryKey, useRpcQuery } from "../rpc.ts";

export const UNAVAILABLE_TITLE = "Whiteboard is unavailable.";

/**
 * Loads the `info` RPC for one panel and re-reads it on `whiteboard:settings`
 * (design §3.2), then renders its children with the result. Loads are
 * near-instant, so the panel stays blank until there is data or an error, as
 * upstream's canvas does.
 */
function InfoGate({
  threadId,
  sessionId,
  children,
}: {
  threadId?: string;
  sessionId?: string;
  children: (info: InfoOutput) => ReactNode;
}) {
  const query = useRpcQuery("info", {
    ...(threadId ? { threadId } : {}),
    ...(sessionId ? { sessionId } : {}),
  });
  useRealtime(CHANNELS.settings, () => {
    void queryClient.invalidateQueries({ queryKey: queryKey("info") });
  });
  if (query.data) return <>{children(query.data)}</>;
  if (query.error) {
    return (
      <EmptyState title={UNAVAILABLE_TITLE} description={query.error.message}>
        <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
          Retry
        </Button>
      </EmptyState>
    );
  }
  return null;
}

export function WhiteboardInfo(props: {
  threadId?: string;
  sessionId?: string;
  children: (info: InfoOutput) => ReactNode;
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <InfoGate {...props} />
    </QueryClientProvider>
  );
}
