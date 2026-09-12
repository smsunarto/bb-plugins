import { useCallback, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { gtdSidebarRpcContract } from "@/server";
import { useCommittedEvent } from "@/hooks/use-committed-event";
import { useLifecycleChannelList } from "@/hooks/use-lifecycle-channel-list";
import { toggleThreadId } from "@/lib/collapsed-threads";

export interface CollapsedThreadsApi {
  /** Thread ids whose children are folded away. */
  collapsedThreads: ReadonlySet<string>;
  toggleThread(threadId: string): void;
}

/** Two fold lists are the same when they hold exactly the same ids. */
export function collapsedThreadsMatch(
  current: ReadonlySet<string>,
  threadIds: readonly string[],
): boolean {
  return current.size === threadIds.length && threadIds.every((id) => current.has(id));
}

/**
 * bb's `sidebar.collapsedThreads` preference as the inbox's fold state — the
 * same list the built-in sidebar folds by, so a family folded there is folded
 * here, and the fold survives a reload.
 *
 * A toggle applies locally first so the row folds on the click, then writes
 * through the backend. The backend relays bb's `ui-preferences-changed` on the
 * `lifecycle` channel, which re-reads the list for every window.
 */
export function useCollapsedThreads(): CollapsedThreadsApi {
  const rpc = useRpc<typeof gtdSidebarRpcContract>();
  const [collapsedThreads, setCollapsedThreads] = useState<ReadonlySet<string>>(() => new Set());
  const applyList = useCallback((threadIds: readonly string[]) => {
    setCollapsedThreads((current) =>
      collapsedThreadsMatch(current, threadIds) ? current : new Set(threadIds),
    );
  }, []);
  useLifecycleChannelList(
    useCallback(() => rpc.call("listCollapsedThreads", {}), [rpc]),
    useCallback((result) => applyList(result.threadIds), [applyList]),
  );
  const toggleThread = useCommittedEvent((threadId: string) => {
    setCollapsedThreads((current) => new Set(toggleThreadId([...current], threadId)));
    rpc
      .call("toggleCollapsedThread", { threadId })
      .then((result) => applyList(result.threadIds))
      // The fold already happened on screen; a write that fails (host
      // unreachable) simply does not outlive this window.
      .catch(() => {});
  });
  return { collapsedThreads, toggleThread };
}
