import { useCallback, useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { orbUsageSettled, type OrbUsageView } from "./orb-usage.ts";
import { appended, useThreadChanges } from "./thread-changes.ts";
import type { rpcContract } from "../server.ts";

/** Settled views by bb thread id, kept for the app's life so a remounted
 *  banner renders without asking again. */
const settledViews = new Map<string, OrbUsageView>();
/** One request per thread at a time, shared by every pane showing it. A
 *  failed request answers null: unknown, so the banner keeps listening. */
const inflight = new Map<string, Promise<OrbUsageView | null>>();
/** A change heard while a request is out may postdate its answer, so it gets
 *  one more request after it, shared by every pane that heard the change. */
const followUps = new Map<string, Promise<OrbUsageView | null>>();

function loadOrbUsage(
  rpc: ReturnType<typeof useRpc<typeof rpcContract>>,
  threadId: string,
  afterChange: boolean,
): Promise<OrbUsageView | null> {
  const running = inflight.get(threadId);
  if (running !== undefined) {
    if (!afterChange) return running;
    let followUp = followUps.get(threadId);
    if (followUp === undefined) {
      followUp = running.then(() => {
        followUps.delete(threadId);
        return loadOrbUsage(rpc, threadId, false);
      });
      followUps.set(threadId, followUp);
    }
    return followUp;
  }
  const request = rpc
    .call("getOrbUsage", { threadId })
    .then((view) => {
      if (orbUsageSettled(view)) settledViews.set(threadId, view);
      return view;
    })
    .catch(() => null)
    .finally(() => inflight.delete(threadId));
  inflight.set(threadId, request);
  return request;
}

/**
 * The Orb banner's view of a thread, or null while it is unknown. The bridge
 * publishes the thread link as `amp/thread-link` extension state, so the view
 * refreshes when that thread appends extension state and stops listening once
 * it settles.
 */
export function useOrbUsage(threadId: string | null): OrbUsageView | null {
  const rpc = useRpc<typeof rpcContract>();
  const cached = threadId === null ? null : (settledViews.get(threadId) ?? null);
  const [loaded, setLoaded] = useState<{ threadId: string; view: OrbUsageView | null } | null>(
    null,
  );
  const view = cached ?? (loaded?.threadId === threadId ? loaded.view : null);

  const refresh = useCallback(
    (afterChange: boolean) => {
      if (threadId === null) return;
      void loadOrbUsage(rpc, threadId, afterChange).then((next) => {
        setLoaded({ threadId, view: next });
        return null;
      });
    },
    [rpc, threadId],
  );

  useEffect(() => {
    if (threadId !== null && !settledViews.has(threadId)) refresh(false);
  }, [threadId, refresh]);

  useThreadChanges(
    threadId,
    view === null || !orbUsageSettled(view),
    (event) => appended(event, ["thread/extensionState/updated"]),
    () => refresh(true),
  );
  return view;
}
