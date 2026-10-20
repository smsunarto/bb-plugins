import { useCallback, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { gtdSidebarRpcContract } from "../server";
import { useCommittedEvent } from "./use-committed-event";
import { useLifecycleChannelList } from "./use-lifecycle-channel-list";

const COLLAPSED_REFRESHES = ["collapsed"] as const;

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
 * thread-list's `collapsedThreads` preference as the inbox's fold state — the
 * same list the built-in sidebar folds by, so a family folded there is folded
 * here, and the fold survives a reload.
 *
 * A toggle applies locally first so the row folds on the click, then writes
 * the fold it wants through the backend. The backend reconciles thread-list's
 * preference and publishes changes on `lifecycle` for every window.
 *
 * A read that overlaps a fold may predate it, so it is dropped, and only the
 * newest fold's answer lands: an older one would refold a family the user has
 * since opened. The backend publishes each change once, so whatever a dropped
 * read carried comes from one more read once the last fold settles.
 */
export function useCollapsedThreads(): CollapsedThreadsApi {
  const rpc = useRpc<typeof gtdSidebarRpcContract>();
  const [collapsedThreads, setCollapsedThreads] = useState<ReadonlySet<string>>(() => new Set());
  const writes = useRef({ sent: 0, settled: 0, reads: 0, dropped: false });
  const applyList = useCallback((threadIds: readonly string[]) => {
    setCollapsedThreads((current) =>
      collapsedThreadsMatch(current, threadIds) ? current : new Set(threadIds),
    );
  }, []);
  const { refresh } = useLifecycleChannelList(
    useCallback(async () => {
      const state = writes.current;
      const sent = state.sent === state.settled ? state.sent : -1;
      state.reads += 1;
      try {
        return { ...(await rpc.call("listCollapsedThreads", {})), sent };
      } finally {
        state.reads -= 1;
      }
    }, [rpc]),
    useCallback(
      (result) => {
        if (result.sent === writes.current.sent) applyList(result.threadIds);
        else writes.current.dropped = true;
      },
      [applyList],
    ),
    COLLAPSED_REFRESHES,
  );
  const toggleThread = useCommittedEvent((threadId: string) => {
    const collapsed = !collapsedThreads.has(threadId);
    const write = ++writes.current.sent;
    setCollapsedThreads((current) => {
      const next = new Set(current);
      if (collapsed) next.add(threadId);
      else next.delete(threadId);
      return next;
    });
    void (async () => {
      try {
        const result = await rpc.call("setThreadCollapsed", { threadId, collapsed });
        if (write === writes.current.sent) applyList(result.threadIds);
      } catch {
        // The fold already happened on screen; a write that fails (host
        // unreachable, thread-list off) is not saved, and stays only until a
        // read replaces it.
      } finally {
        const state = writes.current;
        state.settled += 1;
        // A read still in flight began before this answer and will be dropped;
        // the new read supersedes it.
        if (state.settled === state.sent && (state.dropped || state.reads > 0)) {
          state.dropped = false;
          refresh();
        }
      }
    })();
  });
  return { collapsedThreads, toggleThread };
}
