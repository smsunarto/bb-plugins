import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@bb/plugin-sdk/app";
import { STATUS_EVENT } from "./sidebar-nav-status";
import type { CoreStatus, rpcContract } from "../server";

/** Core status: realtime-pushed on every supervisor transition, with a slow
    self-rescheduling poll (ghostty pattern) covering reconnect gaps. */
export function useCoreStatus(pollMs = 30_000) {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<CoreStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const aliveRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const next = await rpc.call("status");
      if (!aliveRef.current) return;
      setStatus(next);
      setError(null);
      // Hand the realtime transition to the sidebar row, which has no hooks.
      window.dispatchEvent(new CustomEvent(STATUS_EVENT, { detail: next.state }));
    } catch (cause) {
      if (aliveRef.current) setError(String(cause instanceof Error ? cause.message : cause));
    }
  }, [rpc]);

  useRealtime("status", () => {
    void refresh();
  });

  useEffect(() => {
    aliveRef.current = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      await refresh();
      if (aliveRef.current) timer = setTimeout(tick, pollMs);
    };
    void tick();
    return () => {
      aliveRef.current = false;
      if (timer !== null) clearTimeout(timer);
    };
  }, [refresh, pollMs]);

  return { status, error, refresh, rpc };
}
