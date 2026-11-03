// GTD: opening a thread unfolds the way to it: its shelf, its project or
// machine group, its family, and its worktree group. bb's reveal state
// machine (one reveal per navigation, once threads and preferences load) is
// kept as it was.
import { useEffect, useRef } from "react";
import { useSetAtom } from "jotai";
import type { ShelfId } from "../../shared/preferences.js";
import type { SidebarThread } from "../model/sidebar-thread.js";
import {
  collapsedEnvironmentIdsAtom,
  groupFoldsAtom,
  shelfFoldsAtom,
} from "../preferences/atoms.js";
import { groupFoldKey, groupStartsFolded, shelfStartsFolded, withFold } from "../gtd/folds.js";
import { useExpandThreadAncestors } from "./useReadStatusGrouping.js";

export interface SidebarThreadRevealState {
  previousThreadId: string | undefined;
  pendingNavigation: string | undefined;
}

export const INITIAL_SIDEBAR_THREAD_REVEAL_STATE: SidebarThreadRevealState = {
  previousThreadId: undefined,
  pendingNavigation: undefined,
};

interface SidebarThreadRevealStepInputs {
  selectedThreadId: string | undefined;
  threadById: ReadonlyMap<string, SidebarThread>;
  threadsReady: boolean;
  preferencesReady: boolean;
}

interface SidebarThreadRevealStep {
  state: SidebarThreadRevealState;
  revealIds: ReadonlySet<string>;
  navigationRevealId: string | undefined;
}

export function stepSidebarThreadReveal(
  state: SidebarThreadRevealState,
  { selectedThreadId, threadById, threadsReady, preferencesReady }: SidebarThreadRevealStepInputs,
): SidebarThreadRevealStep {
  let { previousThreadId, pendingNavigation } = state;
  if (previousThreadId !== selectedThreadId) {
    previousThreadId = selectedThreadId;
    pendingNavigation = selectedThreadId;
  }
  if (!preferencesReady || !threadsReady) {
    return {
      state: {
        previousThreadId,
        pendingNavigation,
      },
      revealIds: new Set(),
      navigationRevealId: undefined,
    };
  }
  const revealIds = new Set<string>();
  const navigationRevealId = pendingNavigation;
  if (navigationRevealId && threadById.has(navigationRevealId)) {
    revealIds.add(navigationRevealId);
    pendingNavigation = undefined;
  }
  return {
    state: {
      previousThreadId,
      pendingNavigation,
    },
    revealIds,
    navigationRevealId,
  };
}

export interface ThreadRevealPath {
  shelf: ShelfId;
  /** The group header the thread draws under, when headers show. */
  groupKey: string | null;
}

/** The parents and worktree groups between a thread and its family's root. */
export function resolveThreadRevealAncestors(
  thread: SidebarThread,
  threadById: ReadonlyMap<string, SidebarThread>,
) {
  const threadIdsToExpand = new Set<string>();
  const environmentIdsToExpand = new Set<string>();
  let currentThread: SidebarThread | undefined = thread;
  let remainingHops = threadById.size;
  while (currentThread && remainingHops > 0) {
    const environmentId = currentThread.environment?.id ?? null;
    if (environmentId !== null) {
      environmentIdsToExpand.add(environmentId);
    }
    const parentThreadId = currentThread.parentThreadId;
    if (parentThreadId === null) {
      break;
    }
    const parentThread = threadById.get(parentThreadId);
    if (!parentThread) {
      break;
    }
    threadIdsToExpand.add(parentThread.id);
    currentThread = parentThread;
    remainingHops -= 1;
  }
  return { threadIdsToExpand, environmentIdsToExpand };
}

function removeCollapsedIds(current: string[], idsToRemove: ReadonlySet<string>): string[] {
  return current.some((id) => idsToRemove.has(id))
    ? current.filter((id) => !idsToRemove.has(id))
    : current;
}

export function useSidebarThreadReveal({
  selectedThreadId,
  threads,
  threadsReady,
  preferencesReady,
  pathOf,
}: {
  selectedThreadId: string | undefined;
  /** The threads the list draws. */
  threads: readonly SidebarThread[];
  threadsReady: boolean;
  preferencesReady: boolean;
  pathOf: (threadId: string) => ThreadRevealPath | null;
}): void {
  const expandThreadAncestors = useExpandThreadAncestors();
  const setCollapsedEnvironmentIdList = useSetAtom(collapsedEnvironmentIdsAtom);
  const setShelfFolds = useSetAtom(shelfFoldsAtom);
  const setGroupFolds = useSetAtom(groupFoldsAtom);
  const revealState = useRef(INITIAL_SIDEBAR_THREAD_REVEAL_STATE);

  useEffect(() => {
    const threadById = new Map(threads.map((thread) => [thread.id, thread]));
    const step = stepSidebarThreadReveal(revealState.current, {
      selectedThreadId,
      threadById,
      threadsReady,
      preferencesReady,
    });
    revealState.current = step.state;
    for (const threadId of step.revealIds) {
      const thread = threadById.get(threadId);
      const path = pathOf(threadId);
      if (!thread || thread.isHidden || path === null) {
        continue;
      }
      const { threadIdsToExpand, environmentIdsToExpand } = resolveThreadRevealAncestors(
        thread,
        threadById,
      );
      expandThreadAncestors(threadIdsToExpand);
      setCollapsedEnvironmentIdList((current) =>
        removeCollapsedIds(current, environmentIdsToExpand),
      );
      setShelfFolds((current) =>
        withFold(current, path.shelf, false, shelfStartsFolded(path.shelf)),
      );
      const { groupKey } = path;
      if (groupKey !== null) {
        setGroupFolds((current) =>
          withFold(
            current,
            groupFoldKey(path.shelf, groupKey),
            false,
            groupStartsFolded(path.shelf),
          ),
        );
      }
    }
  }, [
    selectedThreadId,
    threadsReady,
    preferencesReady,
    threads,
    pathOf,
    expandThreadAncestors,
    setCollapsedEnvironmentIdList,
    setShelfFolds,
    setGroupFolds,
  ]);
}
