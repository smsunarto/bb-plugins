import type { HeaderBarClickOptions, HeaderBarSegment } from "@bb-plugins/header-bar";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";

/** Lower priority than Captain (10) so Captain crew orientation wins cleanly. */
export const KITCHEN_SINK_LINEAGE_PRIORITY = 20;

function isVisibleThread(thread: PluginSidebarThread): boolean {
  return !thread.isArchived && !thread.isHidden;
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
  const { threadId, threads, onOpenThread } = args;
  const visible = threads.filter(isVisibleThread);
  const byId = new Map<string, PluginSidebarThread>();
  for (const thread of visible) byId.set(thread.id, thread);

  const current = byId.get(threadId);
  if (current === undefined) return [];

  const isFork = current.originKind === "fork" && current.sourceThreadId !== null;
  const parentId = isFork ? current.sourceThreadId : current.parentThreadId;
  const parentThread =
    parentId !== null && parentId !== threadId ? (byId.get(parentId) ?? null) : null;
  if (parentThread === null) return [];

  const prefix = isFork ? "Forked from" : "Parent";
  return [
    {
      owner: "kitchen-sink",
      slot: "lineage",
      priority: KITCHEN_SINK_LINEAGE_PRIORITY,
      prefixIcon: isFork ? "GitBranch" : "ArrowLeft",
      label: parentThread.displayTitle,
      tag: isFork ? "Fork" : undefined,
      tone: "muted",
      shrink: true,
      ariaLabel: `${prefix}: ${parentThread.displayTitle}`,
      title: `${prefix}: ${parentThread.displayTitle}`,
      testId: "ks-hb-lineage",
      onClick: (options) => onOpenThread(parentThread.id, options),
    },
  ];
}
