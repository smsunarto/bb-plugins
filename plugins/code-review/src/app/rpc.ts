import { createRPC, pluginQueryClient } from "@bb-kit/core/rpc/query";
import type plugin from "../server/server.ts";
import { installLocalCache } from "./local-cache.ts";

// Hydrate before any query observer or status gate mounts. The content script
// owns the lifetime, so a plugin reload removes the old subscriber and listeners.
let disposeCache: (() => void) | undefined;
function startCache() {
  if (disposeCache) return;
  try {
    disposeCache = installLocalCache(pluginQueryClient, window.localStorage);
  } catch {
    /* no browser storage */
  }
}
startCache();
export function mountLocalCache(): () => void {
  startCache();
  return () => {
    disposeCache?.();
    disposeCache = undefined;
  };
}

export const rpc = createRPC<(typeof plugin)["rpc"]>();
