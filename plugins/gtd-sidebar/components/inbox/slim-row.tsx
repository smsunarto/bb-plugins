import { memo, useRef, useState, type PointerEvent, type ReactNode } from "react";
import {
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
  type DispatchRowCommand,
  type ThreadAction,
} from "@/components/inbox/thread-actions";
import { STATUS_SLOT_CLASS, StatusOrTime } from "@/components/inbox/status-slot";
import { FadingText, ProjectChip, ThreadDetails } from "@/components/inbox/thread-details";
import type { ProviderGlyphInfo } from "@/components/inbox/provider-glyph";
import { threadDisplayTitle } from "@/lib/inbox";
import { snoozeWakeLabel } from "@/lib/lifecycle";
import { useIosLongPress } from "@/hooks/use-ios-long-press";
import { useCommittedEvent } from "@/hooks/use-committed-event";

interface SlimRowProps {
  thread: PluginSidebarThread;
  isActive: boolean;
  compactThreads: boolean;
  projectName: string | null;
  branchName: string | null;
  provider?: ProviderGlyphInfo;
  shelf: "snoozed" | "settled";
  wakeAt: number | null;
  now: number;
  isCompactViewport: boolean;
  command: DispatchRowCommand;
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
  compactThreads,
  projectName,
  branchName,
  provider,
  isActive,
  shelf,
  wakeAt,
  now,
  isCompactViewport,
  command,
  onSplitPointerDown,
}: SlimRowProps & {
  onSplitPointerDown?: (event: PointerEvent<HTMLElement>) => void;
}) {
  const title = threadDisplayTitle(thread);
  const onRestore = () => command({ kind: "restore", threadId: thread.id, shelf });
  const plan = buildThreadActionPlan({
    lifecycle:
      shelf === "snoozed"
        ? { kind: "snoozed", wakeNow: onRestore }
        : { kind: "settled", unsettle: onRestore },
    isPinned: thread.isPinned,
    setPinned: (pinned) => command({ kind: "pin", threadId: thread.id, pinned }),
    requestDelete: () => command({ kind: "request-delete", threadId: thread.id }),
  });
  const restoreAction = findThreadAction(plan, shelf === "snoozed" ? "wake-now" : "unsettle");
  const [isMenuOpen, setMenuOpen] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const { isPressing, handlers } = useIosLongPress(() => setMenuOpen(true), {
    enabled: isCompactViewport,
  });

  const compact = compactThreads && !isCompactViewport;
  const { rowClassName, titleClassName } = slimRowPresentation({
    isCompactViewport,
    isActive,
    compact,
    isPressing,
    isMenuOpen,
  });
  const status = <SlimRowStatusLabel thread={thread} shelf={shelf} wakeAt={wakeAt} now={now} />;
  const highlightContent = (
    <div className="flex h-full items-center gap-2 px-2.5 text-xs">
      <span className={cn("min-w-0 flex-1 truncate", titleClassName)}>{title}</span>
      <span className={cn(STATUS_SLOT_CLASS, "tabular-nums text-2xs", "text-muted-foreground")}>
        {status}
      </span>
    </div>
  );

  return (
    <RowContextMenu plan={plan} disabled={isCompactViewport}>
      <li className="list-none">
        <div
          ref={rowRef}
          {...handlers}
          data-action-count={isCompactViewport ? 0 : 1}
          className={rowClassName}
        >
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
              href="#"
              aria-label={title}
              onClick={(event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                command({
                  kind: "open",
                  threadId: thread.id,
                  shelf,
                  split: event.metaKey || event.ctrlKey,
                });
              }}
              className="absolute inset-0 cursor-pointer rounded-xl"
            />
          </ThreadDetails>
          {compact ? <ProjectChip name={projectName} /> : null}
          <span
            className={cn(
              "pointer-events-none relative min-w-0 flex-1 truncate",
              titleClassName,
              "group-hover/slim:text-foreground",
            )}
          >
            {isCompactViewport ? title : <FadingText text={title} />}
          </span>
          <SlimRowStatus
            status={status}
            shelf={shelf}
            restoreAction={restoreAction}
            isCompactViewport={isCompactViewport}
          />
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
});

function slimRowPresentation({
  isCompactViewport,
  isActive,
  compact,
  isPressing,
  isMenuOpen,
}: Pick<SlimRowProps, "isCompactViewport" | "isActive"> & {
  compact: boolean;
  isPressing: boolean;
  isMenuOpen: boolean;
}) {
  return {
    rowClassName: cn(
      "group/slim relative flex items-center gap-1.5 rounded-xl px-2.5 text-xs",
      !isCompactViewport && "gtd-thread-row gtd-parked-row",
      compact && "gtd-compact-row",
      "transition-all duration-150",
      isCompactViewport ? "h-11" : "h-8 rounded-md",
      isActive ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60",
      isPressing && "bg-sidebar-accent",
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
  shelf,
  wakeAt,
  now,
}: {
  thread: PluginSidebarThread;
  shelf: "snoozed" | "settled";
  wakeAt: number | null;
  now: number;
}) {
  return shelf === "snoozed" && wakeAt !== null ? (
    snoozeWakeLabel(wakeAt, now)
  ) : (
    <StatusOrTime thread={thread} now={now} />
  );
}

function SlimRowStatus({
  status,
  shelf,
  restoreAction,
  isCompactViewport,
}: {
  status: ReactNode;
  shelf: "snoozed" | "settled";
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
          STATUS_SLOT_CLASS,
          "pointer-events-none relative tabular-nums text-2xs",
          isCompactViewport ? "text-muted-foreground" : "text-muted-foreground/60",
        )}
      >
        <span
          className={cn("flex items-center", !isCompactViewport && "group-hover/slim:opacity-0")}
        >
          {status}
        </span>
        {!isCompactViewport && restoreAction !== undefined ? (
          <RestoreButton action={restoreAction} shelf={shelf} isCompactViewport={false} />
        ) : null}
      </span>
      {isCompactViewport && restoreAction !== undefined ? (
        <RestoreButton action={restoreAction} shelf={shelf} isCompactViewport />
      ) : null}
    </>
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
          : "gtd-restore-button absolute -right-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center opacity-0 focus-visible:opacity-100 group-hover/slim:opacity-100 group-focus-within/slim:opacity-100",
      )}
    >
      <Icon
        name={shelf === "snoozed" ? "Clock" : "ArrowTurnBackward"}
        className={isCompactViewport ? "size-4" : "size-3.5"}
      />
    </button>
  );
}
