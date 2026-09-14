import { useProjectFeatures } from "@/hooks/use-project-features";
import { useCallback, useMemo, useRef, useState } from "react";
import { useRpc, useRealtime } from "@get-bb/plugin-sdk/app";
import { INITIATIVES_CHANNEL } from "@/lib/initiative-types";
import type { Initiative } from "@/lib/initiative-types";
import type { initiativeRpcContract } from "@/lib/initiative-rpc";
import { initiativesByCoordinator } from "@/lib/initiative-ui";
import { useLifecycleChannelList } from "@/hooks/use-lifecycle-channel-list";

const NO_LIFECYCLE_REFRESHES = [] as const;

export interface InitiativesApi {
  /**
   * "loading" until the first answer, "ready" after one succeeds, "error"
   * when a read fails with nothing to show — the rail renders that case as a
   * retry affordance instead of a silently empty Projects section.
   */
  status: "loading" | "ready" | "error";
  active: readonly Initiative[];
  archived: readonly Initiative[];
  byId: ReadonlyMap<string, Initiative>;
  /** coordinatorThreadId -> initiative: how chrome resolves a thread's project. */
  byCoordinator: ReadonlyMap<string, Initiative>;
  /** Re-run the list read after an error. */
  retry: () => void;
}

/**
 * The initiative registry, kept current by the same channel machinery as the
 * lifecycle shelves: reads `listInitiatives`, re-reads on `initiatives`
 * publishes, and refetches on reconnect. A failed read preserves
 * the last list; only a failure with nothing shown turns into `error`.
 */
export function useInitiatives(): InitiativesApi {
  const { projects: enabled } = useProjectFeatures();
  const rpc = useRpc<typeof initiativeRpcContract>();
  const [initiatives, setInitiatives] = useState<readonly Initiative[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const hasData = useRef(false);

  const load = useCallback(async () => {
    if (!enabled) return { initiatives: [] };
    try {
      return await rpc.call("listInitiatives", {});
    } catch (error) {
      if (!hasData.current) setStatus("error");
      throw error;
    }
  }, [rpc, enabled]);
  const apply = useCallback((result: { initiatives: Initiative[] }) => {
    hasData.current = true;
    setInitiatives(result.initiatives);
    setStatus("ready");
  }, []);
  useLifecycleChannelList(load, apply, NO_LIFECYCLE_REFRESHES);

  useRealtime(
    INITIATIVES_CHANNEL,
    useCallback(() => {
      void load()
        .then(apply)
        .catch(() => {});
    }, [load, apply]),
  );

  const retry = useCallback(() => {
    setStatus("loading");
    void load()
      .then(apply)
      .catch(() => {});
  }, [load, apply]);

  return useMemo<InitiativesApi>(() => {
    const active: Initiative[] = [];
    const archived: Initiative[] = [];
    for (const initiative of enabled ? initiatives : []) {
      (initiative.archivedAt === null ? active : archived).push(initiative);
    }
    return {
      status: enabled ? status : "ready",
      active,
      archived,
      byId: new Map((enabled ? initiatives : []).map((initiative) => [initiative.id, initiative])),
      byCoordinator: initiativesByCoordinator(enabled ? initiatives : []),
      retry,
    };
  }, [initiatives, status, retry, enabled]);
}
