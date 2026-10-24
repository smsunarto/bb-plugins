import {
  memo,
  useEffect,
  useRef,
  useId,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
} from "react";
import {
  experimental_useSidebarThreadSplit as useSidebarThreadSplit,
  useSidebarThreadShortcut,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "../ui/icon";
import { cn } from "../../lib/utils";
import { RowContextMenu } from "./row-context-menu";
import { openMenuFromKeyboard } from "./menu-surface";
import { useThreadRename } from "./inline-rename";
import { LIST_HOVER_TRANSITION } from "./row-motion";
import { CompactThreadActionMenu } from "./thread-action-menu";
import {
  buildThreadActionPlan,
  findThreadAction,
  type DispatchRowCommand,
  type ThreadAction,
} from "./thread-actions";
import { STATUS_SLOT_CLASS, ShortcutPill, StatusOrTime, rowDescribedBy } from "./status-slot";
import { FadingText, HostLead, ThreadDetails } from "./thread-details";
import type { ProviderGlyphInfo } from "./provider-glyph";
import { snoozeWakeLabel } from "../../lib/lifecycle";
import { useIosLongPress } from "../../hooks/use-ios-long-press";
import { useCommittedEvent } from "../../hooks/use-committed-event";
import { useMinuteClock } from "../../hooks/use-minute-clock";
import { ThreadHierarchy, TouchDisclosureGlyph, compactRowPaddingLeft } from "./thread-card";

interface SlimRowProps {
  thread: PluginSidebarThread;
  isUnread: boolean;
  isActive: boolean;
  isNaming?: boolean;
  compactThreads: boolean;
  projectName: string | null;
  branchName: string | null;
  provider?: ProviderGlyphInfo;
  shelf: "snoozed" | "settled";
  wakeAt: number | null;
  isCompactViewport: boolean;
  command: DispatchRowCommand;
  depth: number;
  childCount: number;
  expanded: boolean;
  guides: string;
  lastChild: boolean;
  toggleThread: (threadId: string) => void;
}

export const SlimRow = memo(function SlimRow(props: SlimRowProps) {
  const { splitProps } = useSidebarThreadSplit(props.thread.id);
  const onSplitPointerDown = useCommittedEvent((event: PointerEvent<HTMLElement>) => {
    splitProps.onPointerDown?.(event);
  });
  return (
    <SlimRowBody
      {...props}
      onSplitPointerDown={splitProps.onPointerDown ? onSplitPointerDown : undefined}
    />
  );
});

/**
 * A parked thread: one line instead of a card. Density comes from the user
 * actually parking work, never from the sidebar guessing what still matters.
 *
 * Same structure as the card — a full-bleed anchor under the restore button,
 * because a `<button>` inside an `<a>` is invalid interactive nesting.
 */
const SlimRowBody = memo(function SlimRowBody({
  thread,
  isUnread,
  compactThreads,
  projectName,
  branchName,
  provider,
  isActive,
  isNaming = false,
  shelf,
  wakeAt,
  isCompactViewport,
  command,
  depth,
  childCount,
  expanded,
  guides,
  lastChild,
  toggleThread,
  onSplitPointerDown,
}: SlimRowProps & {
  onSplitPointerDown?: (event: PointerEvent<HTMLElement>) => void;
}) {
  const title = thread.displayTitle;
  const unreadId = useId();
  // A snoozed row's slot holds its wake time, so that is what it is heard with.
  const statusId = useId();
  const rename = useThreadRename(thread.id, title);
  const onRestore = () => command({ kind: "restore", threadId: thread.id, shelf });
  const plan = buildThreadActionPlan(
    shelf === "snoozed"
      ? { kind: "snoozed", wakeNow: onRestore }
      : { kind: "settled", unsettle: onRestore },
  );
  const restoreAction = findThreadAction(plan, shelf === "snoozed" ? "wake-now" : "unsettle");
  const [isMenuOpen, setMenuOpen] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const { isPressing, handlers } = useIosLongPress(() => setMenuOpen(true), {
    enabled: isCompactViewport && !rename.isEditing,
  });
  // The sheet only renders on a compact viewport. Leaving it with the sheet
  // open must not strand the row hidden under a sheet that is gone.
  useEffect(() => {
    if (!isCompactViewport) setMenuOpen(false);
  }, [isCompactViewport]);

  const compact = compactThreads && !isCompactViewport;
  const shortcut = useSidebarThreadShortcut(thread.id);
  const { rowClassName, rowStyle, titleClassName } = slimRowPresentation({
    isCompactViewport,
    isActive,
    compact,
    isPressing,
    isMenuOpen,
    depth,
    childCount,
  });
  const status = shortcut ? (
    <ShortcutPill shortcut={shortcut} />
  ) : (
    <SlimRowStatusLabel
      thread={thread}
      isUnread={isUnread}
      shelf={shelf}
      wakeAt={wakeAt}
      isCompactViewport={isCompactViewport}
    />
  );
  // The row's own line, padded by the menu the way the row is padded, so the
  // chevron, title, status and restore glyph hold their places as it lifts.
  const highlightContent = (
    <>
      <TouchDisclosureGlyph depth={depth} childCount={childCount} expanded={expanded} />
      <div className="flex h-full items-center gap-1.5 text-xs">
        <HostLead host={thread.host} />
        <span
          data-gtd-naming={isNaming || undefined}
          className={cn("gtd-naming-text min-w-0 flex-1 truncate", titleClassName)}
        >
          {title}
        </span>
        <span className={cn(STATUS_SLOT_CLASS, "tabular-nums text-2xs", "text-muted-foreground")}>
          {status}
        </span>
        <RestoreGlyph action={restoreAction} />
      </div>
    </>
  );

  return (
    <RowContextMenu thread={thread} plan={plan} rename={rename} disabled={isCompactViewport}>
      <div>
        <div
          ref={rowRef}
          data-sidebar-rename-row=""
          {...handlers}
          data-action-count={isCompactViewport ? 0 : 1}
          className={rowClassName}
          // Merged: the hold's style mutes iOS's link callout and selection.
          style={{ ...handlers.style, ...rowStyle }}
        >
          <ThreadHierarchy
            threadId={thread.id}
            title={title}
            depth={depth}
            childCount={childCount}
            expanded={expanded}
            guides={guides}
            lastChild={lastChild}
            mobile={isCompactViewport}
            toggleThread={toggleThread}
          />
          <ThreadDetails
            thread={thread}
            projectName={projectName}
            branchName={branchName}
            provider={provider}
            enabled={compact}
          >
            {/* oxlint-disable-next-line jsx-a11y/anchor-is-valid -- must stay an
             anchor: the shortcut-target contract and modifier-click
             split-open both depend on it. A button breaks each. */}
            <a
              onPointerDown={onSplitPointerDown}
              data-sidebar-thread-shortcut-target=""
              data-sidebar-thread-id={thread.id}
              data-sidebar-rename-anchor=""
              href="#"
              aria-label={title}
              aria-describedby={rowDescribedBy(statusId, unreadId, {
                thread,
                isUnread,
                shortcut,
              })}
              aria-keyshortcuts={shortcut?.ariaKeyshortcuts}
              aria-current={isActive ? "page" : undefined}
              onKeyDown={(event) => {
                // Shift+F10 or the Menu key, as on a card.
                if (!isCompactViewport) openMenuFromKeyboard(event);
              }}
              onDoubleClick={rename.onDoubleClick}
              onClick={(event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                if (rename.isEditing) return;
                command({
                  kind: "open",
                  threadId: thread.id,
                  split: event.metaKey || event.ctrlKey,
                });
              }}
              className="absolute inset-0 cursor-pointer rounded-xl"
            />
          </ThreadDetails>
          {isUnread ? (
            <span id={unreadId} className="sr-only">
              {thread.isUnread ? "Unread response" : "Unread response in subthreads"}
            </span>
          ) : null}
          <HostLead host={thread.host} />
          {rename.isEditing ? (
            // The title's classes minus the click-through and the clip, which
            // would hide the editor's error below the row.
            <span
              className={cn(
                "relative z-10 min-w-0 flex-1",
                titleClassName,
                "group-hover/slim:text-foreground",
              )}
            >
              {rename.editor}
            </span>
          ) : (
            <span
              data-gtd-naming={isNaming || undefined}
              aria-busy={isNaming || undefined}
              className={cn(
                "pointer-events-none relative min-w-0 flex-1 truncate",
                // The compact viewport paints the title here, not in a FadingText.
                isCompactViewport && "gtd-naming-text",
                titleClassName,
                "group-hover/slim:text-foreground",
              )}
            >
              {isCompactViewport ? title : <FadingText text={title} />}
            </span>
          )}
          <SlimRowStatus
            statusId={statusId}
            status={status}
            restoreAction={restoreAction}
            isCompactViewport={isCompactViewport}
          />
          {isCompactViewport ? (
            <CompactThreadActionMenu
              thread={thread}
              rename={rename}
              plan={plan}
              open={isMenuOpen}
              onOpenChange={setMenuOpen}
              anchorRef={rowRef}
              isActive={isActive}
              highlightContent={highlightContent}
            />
          ) : null}
        </div>
      </div>
    </RowContextMenu>
  );
});

function slimRowPresentation({
  isCompactViewport,
  isActive,
  compact,
  isPressing,
  isMenuOpen,
  depth,
  childCount,
}: Pick<SlimRowProps, "isCompactViewport" | "isActive" | "depth" | "childCount"> & {
  compact: boolean;
  isPressing: boolean;
  isMenuOpen: boolean;
}) {
  return {
    rowStyle: {
      "--gtd-depth": depth,
      // A card's columns, so a family keeps them when it moves shelves.
      ...(isCompactViewport ? { paddingLeft: compactRowPaddingLeft(depth, childCount) } : {}),
    } as CSSProperties,
    rowClassName: cn(
      "group/slim relative flex items-center gap-1.5 rounded-xl px-2.5 text-xs",
      !isCompactViewport && "gtd-thread-row gtd-parked-row",
      compact && "gtd-compact-row",
      LIST_HOVER_TRANSITION,
      isCompactViewport ? "h-11" : "h-8 rounded-md",
      isActive ? "bg-state-active" : "hover:bg-sidebar-accent",
      isPressing && !isActive && "bg-sidebar-accent",
      isMenuOpen && "bg-sidebar-accent opacity-0",
    ),
    titleClassName: cn(
      isCompactViewport ? "text-muted-foreground" : "text-muted-foreground/70",
      isActive && "text-foreground",
    ),
  };
}

function SlimRowStatusLabel({
  thread,
  isUnread,
  shelf,
  wakeAt,
  isCompactViewport,
}: {
  thread: PluginSidebarThread;
  isUnread: boolean;
  shelf: "snoozed" | "settled";
  wakeAt: number | null;
  isCompactViewport: boolean;
}) {
  const now = useMinuteClock();
  if (isUnread)
    return <StatusOrTime thread={thread} isUnread isCompactViewport={isCompactViewport} />;
  return shelf === "snoozed" && wakeAt !== null ? (
    snoozeWakeLabel(wakeAt, now)
  ) : (
    <StatusOrTime thread={thread} isCompactViewport={isCompactViewport} />
  );
}

function SlimRowStatus({
  statusId,
  status,
  restoreAction,
  isCompactViewport,
}: {
  /** The status's id, which the row's link names as its description. */
  statusId: string;
  status: ReactNode;
  restoreAction: ThreadAction | undefined;
  isCompactViewport: boolean;
}) {
  return (
    <>
      {/* The same slot as a card, so a shelf keeps the card's column. A
         snoozed row spends it on the wake time: when the thread comes
         BACK is that shelf's whole question, and it outranks an age the
         user has already decided to ignore.

         The restore button shares this one cell instead of following it.
         A button of its own would sit between the age and the row's edge
         and push the whole column off the card's, which is the one thing
         the fixed slot exists to prevent. */}
      <span
        className={cn(
          "gtd-slim-status-slot",
          STATUS_SLOT_CLASS,
          "pointer-events-none relative tabular-nums text-2xs",
          isCompactViewport ? "text-muted-foreground" : "text-muted-foreground/60",
        )}
      >
        <span
          id={statusId}
          className={cn(
            "gtd-slim-status flex items-center",
            !isCompactViewport && "group-hover/slim:opacity-0",
          )}
        >
          {status}
        </span>
        {!isCompactViewport && restoreAction !== undefined ? (
          <RestoreButton action={restoreAction} isCompactViewport={false} />
        ) : null}
      </span>
      {isCompactViewport && restoreAction !== undefined ? (
        <RestoreButton action={restoreAction} isCompactViewport />
      ) : null}
    </>
  );
}

/** The touch restore button as a picture, for the lifted copy of the row. */
function RestoreGlyph({ action }: { action: ThreadAction | undefined }) {
  if (action === undefined) return null;
  return (
    <span
      aria-hidden
      className="flex size-10 shrink-0 items-center justify-center text-muted-foreground"
    >
      <Icon name={action.icon} className="size-4" />
    </span>
  );
}

function RestoreButton({
  action,
  isCompactViewport,
}: {
  action: ThreadAction;
  isCompactViewport: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={action.label}
      title={action.label}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        action.execute();
      }}
      className={cn(
        "pointer-events-auto rounded text-muted-foreground hover:text-foreground",
        isCompactViewport
          ? "relative z-[1] flex size-10 shrink-0 items-center justify-center hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          : "gtd-restore-button absolute -right-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center opacity-0 focus-visible:opacity-100 group-hover/slim:opacity-100",
      )}
    >
      <Icon name={action.icon} className={isCompactViewport ? "size-4" : "size-3.5"} />
    </button>
  );
}
