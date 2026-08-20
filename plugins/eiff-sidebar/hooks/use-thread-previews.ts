import { useEffect, useRef, useState } from "react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { eiffSidebarRpcContract } from "@/server";

const DEBOUNCE_MS = 300;
const EMPTY_PREVIEWS: ReadonlyMap<string, string> = new Map();

/** Debounced latest-agent-message previews for the threads currently shown. */
export function useThreadPreviews(
  threads: readonly PluginSidebarThread[],
): ReadonlyMap<string, string> {
  const rpc = useRpc<typeof eiffSidebarRpcContract>();
  const [previews, setPreviews] = useState<ReadonlyMap<string, string>>(EMPTY_PREVIEWS);
  const mountedRef = useRef(true);
  const requestSeq = useRef(0);
  const requestKey = JSON.stringify(threads.map(({ id, updatedAt }) => [id, updatedAt]));
  const threadsRef = useRef(threads);
  threadsRef.current = threads;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const seq = ++requestSeq.current;
    const timer = setTimeout(() => {
      const requested = threadsRef.current.map(({ id, updatedAt }) => ({
        threadId: id,
        updatedAt,
      }));
      if (requested.length === 0) {
        if (mountedRef.current && seq === requestSeq.current) setPreviews(EMPTY_PREVIEWS);
        return;
      }

      void (async () => {
        try {
          const result = await rpc.call("previews", { threads: requested });
          if (!mountedRef.current || seq !== requestSeq.current) return;
          setPreviews(
            new Map(
              result.previews
                .filter(
                  (preview): preview is { threadId: string; text: string } =>
                    preview.text !== null,
                )
                .map((preview) => [preview.threadId, preview.text]),
            ),
          );
        } catch {
          // Keep the last good map. A preview failure must never blank rows or
          // become an unhandled rejection in the host app.
        }
      })();
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [requestKey, rpc]);

  return previews;
}
