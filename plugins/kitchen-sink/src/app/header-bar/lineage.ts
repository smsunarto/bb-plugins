import type { HeaderBarClickOptions, HeaderBarSegment } from "@bb-plugins/header-bar";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";

/** Lower priority than Captain (10) so Captain crew orientation wins cleanly. */
export const KITCHEN_SINK_LINEAGE_PRIORITY = 20;

function isVisibleThread(thread: PluginSidebarThread): boolean {
  return !thread.isArchived && !thread.isHidden;
}

export interface KitchenSinkLineage {
  readonly parentId: string;
  readonly parentTitle: string;
  readonly isFork: boolean;
}

/**
 * Find the minimal primitive lineage info for `threadId` in a single pass
 * without building an intermediate Map over all sidebar threads.
 */
export function resolveKitchenSinkLineage(
  threadId: string,
  threads: readonly PluginSidebarThread[],
): KitchenSinkLineage | null {
  let current: PluginSidebarThread | undefined;
  for (const thread of threads) {
    if (thread.id === threadId) {
      if (isVisibleThread(thread)) current = thread;
      break;
    }
  }
  if (current === undefined) return null;

  const isFork = current.originKind === "fork" && current.sourceThreadId !== null;
  const parentId = isFork ? current.sourceThreadId : current.parentThreadId;
  if (parentId === null || parentId === threadId) return null;

  for (const thread of threads) {
    if (thread.id === parentId) {
      if (!isVisibleThread(thread)) return null;
      return { parentId: thread.id, parentTitle: thread.displayTitle, isFork };
    }
  }
  return null;
}

export function buildKitchenSinkLineageSegments(args: {
  readonly parentId: string;
  readonly parentTitle: string;
  readonly isFork: boolean;
  readonly onOpenThread: (threadId: string, options?: HeaderBarClickOptions) => void;
}): readonly HeaderBarSegment[] {
  const { parentId, parentTitle, isFork, onOpenThread } = args;
  const prefix = isFork ? "Forked from" : "Parent";
  return [
    {
      owner: "kitchen-sink",
      slot: "lineage",
      priority: KITCHEN_SINK_LINEAGE_PRIORITY,
      prefixIcon: isFork ? "GitBranch" : "ArrowLeft",
      label: parentTitle,
      tag: isFork ? "Fork" : undefined,
      tone: "muted",
      shrink: true,
      ariaLabel: `${prefix}: ${parentTitle}`,
      title: `${prefix}: ${parentTitle}`,
      testId: "ks-hb-lineage",
      onClick: (options) => onOpenThread(parentId, options),
    },
  ];
}

/**
 * Resolve Kitchen Sink's fallback header-bar segment for a thread:
 * - `lineage` (priority 20): parent or fork jump link when `parentThreadId` or
 *   `sourceThreadId` points to a visible thread.
 *
 * Intentionally does not show subthreads, sibling lists, or generic shared
 * checkouts so parent and standalone threads stay completely clean.
 */
export function buildKitchenSinkHeaderSegments(args: {
  readonly threadId: string;
  readonly threads: readonly PluginSidebarThread[];
  readonly onOpenThread: (threadId: string, options?: HeaderBarClickOptions) => void;
}): readonly HeaderBarSegment[] {
  const lineage = resolveKitchenSinkLineage(args.threadId, args.threads);
  if (lineage === null) return [];
  return buildKitchenSinkLineageSegments({
    ...lineage,
    onOpenThread: args.onOpenThread,
  });
}
