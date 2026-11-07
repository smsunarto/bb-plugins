import { useMemo } from "react";
import { experimental_useThreadExtensionState as useThreadExtensionState } from "@get-bb/plugin-sdk/app";
import { orbUsageFromThreadLinkState, type OrbUsageView } from "./orb-usage.ts";
import { THREAD_LINK_EXTENSION_KIND } from "./thread-link.ts";

/**
 * The Orb banner's view of a thread. The bridge publishes the thread link as
 * extension state, and bb hands the latest one to the app and follows live
 * updates while the thread is shown, so there is no request or refresh loop.
 */
export function useOrbUsage(threadId: string): OrbUsageView {
  const state = useThreadExtensionState(threadId, THREAD_LINK_EXTENSION_KIND);
  return useMemo(() => orbUsageFromThreadLinkState(state), [state]);
}
