import { useCallback, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { gtdSidebarRpcContract } from "@/server";
import { useLifecycleChannelList } from "./use-lifecycle-channel-list";

const NAMING_REFRESHES = ["naming"] as const;

export function useNamingThreads(): ReadonlySet<string> {
  const rpc = useRpc<typeof gtdSidebarRpcContract>();
  const [naming, setNaming] = useState<ReadonlySet<string>>(() => new Set());
  useLifecycleChannelList(
    useCallback(() => rpc.call("listNamingThreads", {}), [rpc]),
    useCallback((threadIds: string[]) => {
      setNaming((current) =>
        current.size === threadIds.length && threadIds.every((id) => current.has(id))
          ? current
          : new Set(threadIds),
      );
    }, []),
    NAMING_REFRESHES,
  );
  return naming;
}
