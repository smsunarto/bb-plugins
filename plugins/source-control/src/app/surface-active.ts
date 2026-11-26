/**
 * Whether a mounted surface should do periodic work. bb keeps hidden thread
 * side-panel tabs mounted, so a tab painted from its snapshot must not keep
 * ticking clocks or polling reads while nobody can see it: it is active only
 * while the tab is shown, the page is visible, and the realtime connection is
 * up. Descendants read the flag from context rather than through every prop.
 */
import { useRealtimeConnectionState } from "@get-bb/plugin-sdk/app";
import { createContext, useContext, useSyncExternalStore } from "react";

function subscribePage(onChange: () => void): () => void {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

const pageVisible = () => document.visibilityState === "visible";

/** `document.visibilityState === "visible"`, kept current. */
export function usePageVisible(): boolean {
  return useSyncExternalStore(subscribePage, pageVisible, () => true);
}

/** The tab is shown, the page is visible, and bb's connection is up. */
export function useSurfaceActive(tabVisible: boolean): boolean {
  const page = usePageVisible();
  const connected = useRealtimeConnectionState() === "connected";
  return tabVisible && page && connected;
}

/** Outside a surface that says otherwise, work runs as before. */
export const SurfaceActive = createContext(true);

export function useActive(): boolean {
  return useContext(SurfaceActive);
}
