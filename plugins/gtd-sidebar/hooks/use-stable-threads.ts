import { useMemo, useState } from "react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { retainUnchangedThreads } from "../lib/stable-threads";

/**
 * `threads` with each unchanged thread kept as the object the last render
 * returned, so memoized rows skip. A rebuilt but equal list returns the stored
 * one; only a real data change stores a new list, which costs one extra pass
 * of the calling component's body.
 */
export function useStableThreads(
  threads: readonly PluginSidebarThread[],
): readonly PluginSidebarThread[] {
  const [stable, setStable] = useState(threads);
  const retained = useMemo(() => retainUnchangedThreads(stable, threads), [stable, threads]);
  if (retained !== stable) setStable(retained);
  return retained;
}
