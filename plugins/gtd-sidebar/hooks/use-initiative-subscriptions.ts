import { useProjectFeatures } from "@/hooks/use-project-features";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc, useRealtime, useRealtimeConnectionState } from "@get-bb/plugin-sdk/app";
import { SUBSCRIPTIONS_CHANNEL } from "@/lib/initiative-types";
import type { InitiativeSubscription } from "@/lib/initiative-types";
import type { initiativeRpcContract } from "@/lib/initiative-rpc";

export interface InitiativeSubscriptionsApi {
  status: "loading" | "ready" | "error";
  subscriptions: readonly InitiativeSubscription[];
  enabledCount: number;
  retry: () => void;
}

/**
 * One initiative's subscription rows, refreshed on the real subscription
 * channel (`initiative-subscriptions`) and on reconnect. Same error posture
 * as useInitiatives: a failed read with nothing to show becomes "error".
 *
 * Every reload carries a generation: switching initiatives invalidates the
 * previous project's in-flight read, so a slow response can never overwrite
 * the new project's list.
 */
export function useInitiativeSubscriptions(
  requestedInitiativeId: string | null,
): InitiativeSubscriptionsApi {
  const { subscriptions: enabled } = useProjectFeatures();
  const initiativeId = enabled ? requestedInitiativeId : null;
  const rpc = useRpc<typeof initiativeRpcContract>();
  const [subscriptions, setSubscriptions] = useState<readonly InitiativeSubscription[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const generation = useRef(0);
  const hasData = useRef(false);

  const reload = useCallback(() => {
    if (initiativeId === null) return;
    const gen = ++generation.current;
    void rpc
      .call("listSubscriptions", { initiativeId })
      .then((result) => {
        if (gen !== generation.current) return;
        hasData.current = true;
        setSubscriptions(result.subscriptions);
        setStatus("ready");
      })
      .catch(() => {
        if (gen !== generation.current) return;
        if (!hasData.current) setStatus("error");
      });
  }, [initiativeId, rpc]);

  useEffect(() => {
    generation.current += 1;
    hasData.current = false;
    setSubscriptions([]);
    setStatus(initiativeId === null ? "ready" : "loading");
    reload();
  }, [reload, initiativeId]);

  useRealtime(
    SUBSCRIPTIONS_CHANNEL,
    useCallback(() => {
      reload();
    }, [reload]),
  );

  const connectionState = useRealtimeConnectionState();
  const previous = useRef(connectionState);
  useEffect(() => {
    const before = previous.current;
    previous.current = connectionState;
    if (before === "reconnecting" && connectionState === "connected") reload();
  }, [connectionState, reload]);

  const retry = useCallback(() => {
    setStatus("loading");
    reload();
  }, [reload]);

  return {
    status,
    subscriptions: enabled ? subscriptions : [],
    enabledCount: (enabled ? subscriptions : []).filter((subscription) => subscription.enabled)
      .length,
    retry,
  };
}
