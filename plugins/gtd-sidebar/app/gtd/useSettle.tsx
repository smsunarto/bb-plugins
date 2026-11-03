// Settle: bb's own Archive (its parent confirmation, pane cleanup, and Undo),
// then the open thread moves to the next visible row of the shelf it left.
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  experimental_useThreadActions as useThreadActions,
  useBbNavigate,
  type PluginThreadActionTarget,
} from "@get-bb/plugin-sdk/app";
import { useCommittedEvent } from "../../hooks/use-committed-event.ts";
import { archiveAsksFirst, nextThreadIdAfterSettle } from "../../lib/inbox.ts";
import type { SidebarThread } from "../model/sidebar-thread.ts";
import { toThreadActionTarget } from "../rows/threadActionTarget.ts";

const ARCHIVE_KEYS = ["bb--core/archive"];

interface ArchiveRequest {
  id: number;
  thread: PluginThreadActionTarget;
}

/**
 * bb binds an action to one thread through a hook, and a list must not
 * subscribe every row to it to settle one. So each request mounts a runner
 * that reads the thread's Archive, starts it once, and unmounts.
 */
function ArchiveRunner({
  request,
  onDone,
}: {
  request: ArchiveRequest;
  onDone: (id: number) => void;
}) {
  const [entry] = useThreadActions(request.thread, { keys: ARCHIVE_KEYS });
  const started = useRef(false);
  useEffect(() => {
    // Once per request: a strict-mode remount keeps the ref.
    if (started.current) return;
    started.current = true;
    if (entry !== undefined && entry.action.disabled !== true) void entry.action.run();
    onDone(request.id);
  }, [entry, onDone, request.id]);
  return null;
}

interface PendingAdvance {
  settledThreadId: string;
  nextThreadId: string;
  /** bb asked first, so the advance also waits for the list to drop the thread. */
  awaitsArchive: boolean;
}

/**
 * `visibleRows(threadId)` is the settled thread's shelf as the user sees it,
 * top to bottom, or null when the thread is not on screen.
 */
export function useSettle({
  activeThreadId,
  threads,
  visibleRows,
  onNavigate,
}: {
  activeThreadId: string | null;
  /** bb's roster: archive state and the raw parent links bb's archive follows. */
  threads: readonly SidebarThread[];
  visibleRows: (threadId: string) => readonly string[] | null;
  onNavigate?: () => void;
}): { settle: (threadId: string) => void; runners: ReactNode } {
  const navigate = useBbNavigate();
  const [requests, setRequests] = useState<readonly ArchiveRequest[]>([]);
  const nextId = useRef(0);
  const finish = useCommittedEvent((id: number) => {
    setRequests((current) => current.filter((request) => request.id !== id));
  });
  // bb's archive sends the viewer to the compose screen once the mutation
  // resolves, which can land after the neighbour's route. The neighbour is
  // therefore opened again from this effect once the view has left the
  // settled thread for nothing.
  const pending = useRef<PendingAdvance | null>(null);
  useEffect(() => {
    const advance = pending.current;
    if (advance === null || activeThreadId === advance.settledThreadId) return;
    if (activeThreadId !== null) {
      pending.current = null;
      return;
    }
    // A cancelled confirmation leaves the thread live; an empty route is then
    // the composer opened by hand, not the archive landing, so stay put.
    if (
      advance.awaitsArchive &&
      threads.some((thread) => thread.id === advance.settledThreadId && !thread.isArchived)
    ) {
      return;
    }
    pending.current = null;
    navigate.toThread(advance.nextThreadId);
  }, [activeThreadId, navigate, threads]);

  const settle = useCommittedEvent((threadId: string) => {
    const thread = threads.find((entry) => entry.id === threadId);
    if (thread === undefined || thread.isArchived) return;
    const rows = visibleRows(threadId);
    if (rows !== null) {
      // bb's archive takes the children with it, so a descendant is never a
      // neighbour to land on.
      const parentOf = new Map(threads.map((entry) => [entry.id, entry.parentThreadId]));
      const underSettled = (id: string): boolean => {
        const seen = new Set<string>();
        for (let cursor = parentOf.get(id) ?? null; cursor !== null;) {
          if (cursor === threadId) return true;
          if (seen.has(cursor)) return false;
          seen.add(cursor);
          cursor = parentOf.get(cursor) ?? null;
        }
        return false;
      };
      const section = rows.filter((id) => !underSettled(id)).map((id) => ({ id }));
      const nextThreadId = nextThreadIdAfterSettle(section, threadId, activeThreadId);
      if (nextThreadId !== null) {
        const awaitsArchive = archiveAsksFirst(threads, threadId);
        pending.current = { settledThreadId: threadId, nextThreadId, awaitsArchive };
        // A parent waits on bb's confirmation, so only the effect advances,
        // once the archive lands. A cancel leaves the user in place.
        if (!awaitsArchive) {
          navigate.toThread(nextThreadId);
          onNavigate?.();
        }
      }
    }
    const id = ++nextId.current;
    setRequests((current) => [...current, { id, thread: toThreadActionTarget(thread) }]);
  });

  const runners = requests.map((request) => (
    <ArchiveRunner key={request.id} request={request} onDone={finish} />
  ));
  return { settle, runners };
}
