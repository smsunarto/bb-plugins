import { useRef, useState } from "react";
import {
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  experimental_useSidebarThreadSplit as useSidebarThreadSplit,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { RowContextMenu } from "@/components/inbox/row-context-menu";
import { CompactThreadActionMenu } from "@/components/inbox/thread-action-menu";
import {
  buildThreadActionPlan,
  findThreadAction,
  type ThreadAction,
} from "@/components/inbox/thread-actions";
import { STATUS_SLOT_CLASS, StatusOrTime } from "@/components/inbox/status-slot";
import { threadDisplayTitle } from "@/lib/inbox";
import { snoozeWakeLabel } from "@/lib/lifecycle";
import { useThreadNaming } from "@/hooks/use-thread-naming";
import { useIosLongPress } from "@/hooks/use-ios-long-press";

/**
 * A parked thread: one line instead of a card. Density comes from the user
 * actually parking work, never from the sidebar guessing what still matters.
 *
 * Same structure as the card — a full-bleed anchor under the restore button,
 * because a `<button>` inside an `<a>` is invalid interactive nesting.
 */
export function SlimRow({
  thread,
  isActive,
  shelf,
  wakeAt,
  now,
  isCompactViewport,
  onNavigate,
  onRestore,
}: {
  thread: PluginSidebarThread;
  isActive: boolean;
  shelf: "snoozed" | "settled";
  wakeAt: number | null;
  now: number;
  isCompactViewport: boolean;
  onNavigate: () => void;
  onRestore: () => void;
}) {
  const actions = useSidebarThreadActions();
  const { splitProps, isAvailable: isSplitAvailable } = useSidebarThreadSplit(thread.id);
  const { renameThread } = useThreadNaming(thread.id);
  const title = threadDisplayTitle(thread);
  const plan = buildThreadActionPlan({
    lifecycle:
      shelf === "snoozed"
        ? { kind: "snoozed", wakeNow: onRestore }
        : { kind: "settled", unsettle: onRestore },
    split: {
      isAvailable: isSplitAvailable,
      open: () => {
        actions.open(thread.id, { split: true });
        onNavigate();
      },
    },
    isUnread: thread.isUnread,
    isPinned: thread.isPinned,
    setRead: (read) => void actions.setRead(thread.id, read),
    setPinned: (pinned) => void actions.setPinned(thread.id, pinned),
    renameThread: () => void renameThread(),
    archive: () => actions.archive(thread.id),
    requestDelete: () => actions.requestDelete(thread.id),
  });
  const restoreAction = findThreadAction(plan, shelf === "snoozed" ? "wake-now" : "unsettle");
  const [isMenuOpen, setMenuOpen] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const { isPressing, handlers } = useIosLongPress(() => setMenuOpen(true), {
    enabled: isCompactViewport,
  });

  const highlightContent = isCompactViewport ? (
    <div className="flex h-full items-center gap-2 px-2.5 text-xs">
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          isActive
            ? "text-foreground"
            : isCompactViewport
              ? "text-muted-foreground"
              : "text-muted-foreground/70",
        )}
      >
        {title}
      </span>
      <span className={cn(STATUS_SLOT_CLASS, "tabular-nums text-2xs", "text-muted-foreground")}>
        {shelf === "snoozed" && wakeAt !== null ? (
          snoozeWakeLabel(wakeAt, now)
        ) : (
          <StatusOrTime thread={thread} now={now} />
        )}
      </span>
    </div>
  ) : null;

  return (
    <RowContextMenu plan={plan} disabled={isCompactViewport}>
      <li className="list-none">
        <div
          ref={rowRef}
          {...handlers}
          className={cn(
            "group/slim relative flex items-center gap-2 rounded-xl px-2.5 text-xs transition-all duration-150",
            isCompactViewport ? "h-11" : "h-7 rounded-md",
            isActive ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60",
            isPressing && "bg-sidebar-accent",
            isMenuOpen && "bg-sidebar-accent opacity-0",
          )}
        >
          {/* oxlint-disable-next-line jsx-a11y/anchor-is-valid -- must stay an
              anchor: the shortcut-target contract and modifier-click
              split-open both depend on it. A button breaks each. */}
          <a
            {...splitProps}
            data-sidebar-thread-shortcut-target=""
            data-sidebar-thread-id={thread.id}
            href="#"
            aria-label={title}
            onClick={(event) => {
              event.preventDefault();
              actions.open(thread.id, {
                split: event.metaKey || event.ctrlKey,
              });
              onNavigate();
            }}
            className="absolute inset-0 cursor-pointer rounded-xl"
          />
          <span
            className={cn(
              "pointer-events-none relative min-w-0 flex-1 truncate",
              isActive
                ? "text-foreground"
                : isCompactViewport
                  ? "text-muted-foreground"
                  : "text-muted-foreground/70",
              "group-hover/slim:text-foreground",
            )}
          >
            {title}
          </span>
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
              STATUS_SLOT_CLASS,
              "pointer-events-none relative tabular-nums text-2xs",
              isCompactViewport ? "text-muted-foreground" : "text-muted-foreground/60",
            )}
          >
            <span
              className={cn(
                "flex items-center",
                !isCompactViewport && "group-hover/slim:opacity-0",
              )}
            >
              {shelf === "snoozed" && wakeAt !== null ? (
                snoozeWakeLabel(wakeAt, now)
              ) : (
                <StatusOrTime thread={thread} now={now} />
              )}
            </span>
            {!isCompactViewport && restoreAction !== undefined ? (
              <RestoreButton action={restoreAction} shelf={shelf} isCompactViewport={false} />
            ) : null}
          </span>
          {isCompactViewport && restoreAction !== undefined ? (
            <RestoreButton action={restoreAction} shelf={shelf} isCompactViewport />
          ) : null}
          {isCompactViewport ? (
            <CompactThreadActionMenu
              plan={plan}
              open={isMenuOpen}
              onOpenChange={setMenuOpen}
              anchorRef={rowRef}
              highlightContent={highlightContent}
            />
          ) : null}
        </div>
      </li>
    </RowContextMenu>
  );
}

function RestoreButton({
  action,
  shelf,
  isCompactViewport,
}: {
  action: ThreadAction;
  shelf: "snoozed" | "settled";
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
          : "absolute -right-0.5 top-1/2 -translate-y-1/2 p-0.5 opacity-0 focus-visible:opacity-100 group-hover/slim:opacity-100",
      )}
    >
      <Icon
        name={shelf === "snoozed" ? "Clock" : "ArrowTurnBackward"}
        className={isCompactViewport ? "size-4" : "size-3.5"}
      />
    </button>
  );
}
