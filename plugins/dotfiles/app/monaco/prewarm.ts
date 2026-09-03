import { useEffect, useRef } from "react";
import { rpc } from "../rpc.ts";
import { monacoRuntime, type MonacoAcquisition } from "./runtime.ts";

// Boots Monaco while the panel waits for a file selection, so the first file a
// user opens does not pay the asset fetch. The editor still acquires the
// runtime itself, and both callers share the one cached boot.
export function useMonacoPrewarm(): void {
  const client = rpc.useClient();
  const assetsRef = useRef(() => client.monacoAssets());
  assetsRef.current = () => client.monacoAssets();

  useEffect(() => {
    let disposed = false;
    let acquisition: MonacoAcquisition | null = null;

    void (async () => {
      try {
        const acquired = await monacoRuntime.acquire(() => assetsRef.current());
        if (disposed) {
          acquired.release();
          return;
        }
        acquisition = acquired;
      } catch {
        // A failed prewarm stays silent. The editor reports the same boot
        // failure with a retry once the user opens a file.
      }
    })();

    return () => {
      disposed = true;
      acquisition?.release();
    };
  }, []);
}
