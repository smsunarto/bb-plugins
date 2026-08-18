import { useCallback, useEffect, useRef } from "react";
import { refreshRetryDelayMs } from "@/lib/lifecycle";

/**
 * A list read that comes back on its own after a rejection.
 *
 * Both of this plugin's list reads recover from a `lifecycle` publish or from a
 * socket re-connection, and a plugin-RPC failure produces neither: `rpc.call`
 * rejects on any non-ok response, the realtime channel it travels beside stays
 * up, and the next publish only comes from a mutation the user may never make.
 * So one bad answer at mount time strands that mount — the settled shelf stays
 * empty and the lifecycle rows stay a guess that never becomes a fact — with
 * nothing on screen saying so.
 *
 * The attempt count belongs to the chain rather than to the hook: a call made
 * from anywhere else starts its own, so a publish or a reconnect always gets a
 * full budget instead of inheriting a spent one.
 *
 * `read` owns its own success and failure handling; this only decides when to
 * ask again. A rejection it does not intend to be retried should not leave
 * `read`.
 */
export function useRetryingRead(read: () => Promise<void>): () => void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // An unmount has to take the timer with it. A retry that fires afterwards
  // would call into an instance React has already thrown away, and — through
  // `rpc.call` — write a cache entry on behalf of a mount that is gone.
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  return useCallback(() => {
    const attemptRead = (attempt: number): void => {
      // A read starting now supersedes one that was merely scheduled, whichever
      // chain armed it.
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      void read().catch(() => {
        const delay = refreshRetryDelayMs(attempt);
        if (delay === null) return;
        timer.current = setTimeout(() => {
          timer.current = null;
          attemptRead(attempt + 1);
        }, delay);
      });
    };
    attemptRead(0);
  }, [read]);
}
