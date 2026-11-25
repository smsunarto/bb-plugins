import { useMemo, useState, type ReactNode } from "react";
import {
  experimental_Icon as RegistryIcon,
  experimental_useSidebarThreads as useSidebarThreads,
  experimental_useThreadActions as useThreadActions,
  useBbNavigate,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { Button } from "../ui/button";
import { ARCHIVE_ACTION_KEY, toThreadActionTarget } from "../../lib/thread-action-target";
import { hasSidebarActions, settleThread } from "../../lib/sidebar-actions-bridge";
import { isLongLivedThread } from "../../lib/long-lived";

/** The attribute `header-settle-style.ts` keys the "…" hide on. */
export const HEADER_SETTLE_ATTRIBUTE = "data-gtd-header-settle";

const ARCHIVE_KEYS = [ARCHIVE_ACTION_KEY];

// `icon-sm` is 28px with a 16px glyph, as bb's header icon buttons; under a
// coarse pointer a 44px touch target (AGENTS.md) with a 22px glyph.
const ICON_BUTTON_CLASS =
  "max-md:pointer-coarse:size-11 [&_[data-icon-root]]:size-4 max-md:pointer-coarse:[&_[data-icon-root]]:size-[22px]";

interface HeaderActionProps {
  threadId: string;
  projectId: string;
  isCompactViewport: boolean;
}

/** bb still mounts the legacy thread-header slot; SDK 0.6.92 dropped its types. */
export interface LegacyThreadHeaderActionSlots {
  experimental_threadHeaderAction(registration: {
    id: string;
    title: string;
    component: (props: HeaderActionProps) => ReactNode;
  }): void;
}

/**
 * New thread and Settle in the open thread's header on a phone. Settle stands
 * in for bb's "…" thread menu. Desktop headers render nothing and hold no
 * subscriptions.
 */
export function HeaderSettle({ threadId, projectId, isCompactViewport }: HeaderActionProps) {
  if (!isCompactViewport) return null;
  return (
    <>
      <NewThreadButton projectId={projectId} />
      <CompactHeaderSettle threadId={threadId} />
    </>
  );
}

/** Opens the New thread screen with the open thread's project selected. */
function NewThreadButton({ projectId }: { projectId: string }) {
  const navigate = useBbNavigate();
  return (
    <Button
      data-bb-plugin="gtd-sidebar"
      data-bb-plugin-scope-gtd-sidebar=""
      variant="ghost"
      size="icon-sm"
      aria-label="New thread"
      title="New thread"
      onClick={() =>
        navigate.toCompose({
          projectId,
          focusPrompt: true,
        })
      }
      className={ICON_BUTTON_CLASS}
    >
      <RegistryIcon name="Edit" aria-hidden />
    </Button>
  );
}

function CompactHeaderSettle({ threadId }: { threadId: string }) {
  const { threads } = useSidebarThreads();
  const row = threads.find((thread) => thread.id === threadId);
  // A settled or unlisted thread keeps bb's menu, where Unarchive lives.
  // A Captain stays open (lib/long-lived), so it offers no Settle at all.
  if (row === undefined || row.isArchived || isLongLivedThread(row)) return null;
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
      data-bb-plugin-scope-gtd-sidebar=""
      variant="ghost"
      size="icon-sm"
      aria-label="Settle"
      title="Settle"
      disabled={running || archive === undefined || archive.action.disabled === true}
      onClick={settle}
      className={ICON_BUTTON_CLASS}
    >
      <RegistryIcon name="CircleCheck" aria-hidden />
    </Button>
  );
}
