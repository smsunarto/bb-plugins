import { useMemo, useState, type ReactNode } from "react";
import {
  experimental_useSidebarThreads as useSidebarThreads,
  experimental_useThreadActions as useThreadActions,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { Button } from "../ui/button";
import { ARCHIVE_ACTION_KEY, toThreadActionTarget } from "../../lib/thread-action-target";
import { hasSidebarActions, settleThread } from "../../lib/sidebar-actions-bridge";

/** The attribute `header-settle-style.ts` keys the "…" hide on. */
export const HEADER_SETTLE_ATTRIBUTE = "data-gtd-header-settle";

const ARCHIVE_KEYS = [ARCHIVE_ACTION_KEY];

/** bb still mounts the legacy thread-header slot; SDK 0.6.92 dropped its types. */
export interface LegacyThreadHeaderActionSlots {
  experimental_threadHeaderAction(registration: {
    id: string;
    title: string;
    component: (props: { threadId: string; isCompactViewport: boolean }) => ReactNode;
  }): void;
}

/**
 * Settle in the open thread's header on a phone, where it stands in for bb's
 * "…" thread menu. Desktop headers render nothing and hold no subscriptions.
 */
export function HeaderSettle({
  threadId,
  isCompactViewport,
}: {
  threadId: string;
  isCompactViewport: boolean;
}) {
  return isCompactViewport ? <CompactHeaderSettle threadId={threadId} /> : null;
}

function CompactHeaderSettle({ threadId }: { threadId: string }) {
  const { threads } = useSidebarThreads();
  const row = threads.find((thread) => thread.id === threadId);
  // A settled or unlisted thread keeps bb's menu, where Unarchive lives.
  if (row === undefined || row.isArchived) return null;
  return <SettleButton thread={row} />;
}

function SettleButton({ thread }: { thread: PluginSidebarThread }) {
  const target = useMemo(() => toThreadActionTarget(thread), [thread]);
  const [archive] = useThreadActions(target, { keys: ARCHIVE_KEYS });
  const [running, setRunning] = useState(false);
  const settle = () => {
    // The mounted sidebar settles as its rows do: archive, then open the
    // next thread on the shelf. Without it, bb's own Archive.
    if (hasSidebarActions()) {
      settleThread(thread.id);
      return;
    }
    if (archive === undefined) return;
    setRunning(true);
    // bb's action owns the confirmation, the Undo toast and failure toasts.
    void archive.action
      .run()
      .catch(() => {})
      .finally(() => setRunning(false));
  };
  return (
    <Button
      {...{ [HEADER_SETTLE_ATTRIBUTE]: "" }}
      data-bb-plugin="gtd-sidebar"
      variant="outline"
      disabled={running || archive === undefined || archive.action.disabled === true}
      onClick={settle}
      className="h-7 px-2 text-xs font-normal max-md:pointer-coarse:h-9 max-md:pointer-coarse:text-sm"
    >
      Settle
    </Button>
  );
}
