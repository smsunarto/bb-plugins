import { useCallback, useEffect, useMemo, useState } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import type { SidebarThread } from "../model/sidebar-thread.js";
import type { ThreadComparator } from "../model/project-thread-groups.js";
import {
  createThreadUnreadPredicate,
  groupComparatorByReadStatus,
  rememberHeldReadStatus,
  resolveHeldReadStatus,
  restoreHeldReadStatus,
  type HeldReadStatus,
} from "../model/read-status-grouping.js";
import { expandedThreadIdsAtom, sidebarGroupByReadStatusAtom } from "../preferences/atoms.js";
import { collapsedParents, toggleExpanded } from "../gtd/folds.js";

function useHeldReadStatus(
  threads: readonly SidebarThread[],
  selectedThreadId: string | undefined,
): HeldReadStatus | null {
  const [held, setHeld] = useState<HeldReadStatus | null>(() =>
    restoreHeldReadStatus(selectedThreadId),
  );
  useEffect(() => {
    rememberHeldReadStatus(held);
  }, [held]);
  const next = resolveHeldReadStatus(held, threads, selectedThreadId);
  if (next !== held) {
    setHeld(next);
  }
  return next;
}

export function useReadStatusGrouping({
  threads,
  selectedThreadId,
  comparator,
}: {
  threads: readonly SidebarThread[];
  selectedThreadId: string | undefined;
  comparator: ThreadComparator;
}) {
  const groupByReadStatus = useAtomValue(sidebarGroupByReadStatusAtom);
  const heldReadStatus = useHeldReadStatus(threads, selectedThreadId);
  const [expandedThreadIdList, setExpandedThreadIdList] = useAtom(expandedThreadIdsAtom);
  const groupedComparator = useMemo(
    () =>
      groupByReadStatus
        ? groupComparatorByReadStatus(comparator, createThreadUnreadPredicate(heldReadStatus))
        : comparator,
    [comparator, groupByReadStatus, heldReadStatus],
  );
  // GTD: families start folded whatever the grouping; the preference holds
  // the ones the user opened.
  const collapsedThreadIds = useMemo(
    () => collapsedParents(threads, expandedThreadIdList),
    [expandedThreadIdList, threads],
  );
  const toggleThreadCollapsed = useCallback(
    (threadId: string) => {
      const listed = new Set(threads.map((thread) => thread.id));
      setExpandedThreadIdList((current) => toggleExpanded(current, threadId, listed));
    },
    [setExpandedThreadIdList, threads],
  );
  return {
    comparator: groupedComparator,
    collapsedThreadIds,
    toggleThreadCollapsed,
  };
}

export function useExpandThreadAncestors() {
  const setExpandedThreadIdList = useSetAtom(expandedThreadIdsAtom);
  return useCallback(
    (threadIds: ReadonlySet<string>) => {
      setExpandedThreadIdList((current) =>
        [...threadIds].every((id) => current.includes(id))
          ? current
          : [...new Set([...current, ...threadIds])],
      );
    },
    [setExpandedThreadIdList],
  );
}
