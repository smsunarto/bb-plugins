import { PluginQueryBoundary, pluginQueryClient } from "@bb-kit/core/rpc/query";
import { useRealtime } from "@get-bb/plugin-sdk/app";
import type { ReactNode } from "react";
import type { InfoOutput } from "../../shared/contracts/api-tunnel.ts";
import { CHANNELS } from "../../shared/contracts/channels.ts";
import { Button } from "../components/ui/button.tsx";
import { EmptyState } from "../panel/empty-state.tsx";
import { rpc } from "../rpc.ts";

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
  const query = rpc.info.useQuery({
    ...(threadId ? { threadId } : {}),
    ...(sessionId ? { sessionId } : {}),
  });
  useRealtime(CHANNELS.settings, () => {
    void pluginQueryClient.invalidateQueries({ queryKey: rpc.info.queryKey() });
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
    <PluginQueryBoundary>
      <InfoGate {...props} />
    </PluginQueryBoundary>
  );
}
