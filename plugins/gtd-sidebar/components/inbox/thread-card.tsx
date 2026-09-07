import { memo, useRef, useState, type PointerEvent, type ReactNode } from "react";
import {
  experimental_useSidebarThreadPullRequest as useSidebarThreadPullRequest,
  experimental_useSidebarThreadSplit as useSidebarThreadSplit,
  type PluginSidebarPullRequest,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { Icon, type IconName } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { RowContextMenu } from "@/components/inbox/row-context-menu";
import { CompactThreadActionMenu } from "@/components/inbox/thread-action-menu";
import {
  buildThreadActionPlan,
  findThreadAction,
  type ActiveThreadShelf,
  type DispatchRowCommand,
  type ThreadActionPlan,
} from "@/components/inbox/thread-actions";
import { ProviderGlyph, type ProviderGlyphInfo } from "@/components/inbox/provider-glyph";
import { StatusGlyph, hasStatusGlyph } from "@/components/inbox/status-glyph";
import { STATUS_SLOT_CLASS, StatusOrTime } from "@/components/inbox/status-slot";
import { threadDisplayTitle } from "@/lib/inbox";
import { snoozeUntilTomorrow } from "@/lib/lifecycle";
import { useIosLongPress } from "@/hooks/use-ios-long-press";
import { useCommittedEvent } from "@/hooks/use-committed-event";

interface ThreadCardProps {
  thread: PluginSidebarThread;
  shelf: ActiveThreadShelf;
  provider?: ProviderGlyphInfo;
  projectName: string | null;
  /** bb's branch, or GitButler's virtual-branch summary for its workspace. */
  branchName: string | null;
  isActive: boolean;
  /** False while the thread is working or blocked on the user. */
  canPark: boolean;
  /** The `showProviderIcon` setting, on by default. */
  showProviderIcon: boolean;
  isCompactViewport: boolean;
  command: DispatchRowCommand;
  /** Quantized clock, so every card in one render agrees on "now". */
  now: number;
}

export const ThreadCard = memo(function ThreadCard(props: ThreadCardProps) {
  const { splitProps, layout } = useSidebarThreadSplit(props.thread.id);
  const { pullRequest } = useSidebarThreadPullRequest(props.thread.id);
  const onSplitPointerDown = useCommittedEvent((event: PointerEvent<HTMLElement>) => {
    splitProps.onPointerDown?.(event);
  });
  return (
    <ThreadCardBody
      {...props}
      pullRequest={pullRequest}
      isOpenInSplit={layout !== null}
      onSplitPointerDown={splitProps.onPointerDown ? onSplitPointerDown : undefined}
    />
  );
});

/**
 * One thread as a two-line card: title and status, then project, branch and
 * activity. Status stays in the row while section placement answers the larger
 * question: whether the user or the agent can act next. The compact viewport
 * folds the card to its first line.
 *
 * The row is a positioned container with a full-bleed anchor UNDER the
 * controls, the way bb's own thread row does it: a `<button>` inside an `<a>`
 * is invalid interactive nesting and breaks keyboard behaviour.
 */
const ThreadCardBody = memo(function ThreadCardBody({
  thread,
  shelf,
  provider,
  projectName,
  branchName,
  isActive,
  canPark,
  showProviderIcon,
  isCompactViewport,
  command,
  now,
  pullRequest,
  isOpenInSplit,
  onSplitPointerDown,
}: ThreadCardProps & {
  pullRequest: PluginSidebarPullRequest | null;
  isOpenInSplit: boolean;
  onSplitPointerDown?: (event: PointerEvent<HTMLElement>) => void;
}) {
  const plan = buildThreadActionPlan({
    lifecycle: {
      kind: "active",
      canPark,
      snoozeUntilTomorrow: () =>
        command({ kind: "snooze", threadId: thread.id, until: snoozeUntilTomorrow(new Date()) }),
      settle: () => command({ kind: "settle", threadId: thread.id, shelf }),
    },
    isPinned: thread.isPinned,
    setPinned: (pinned) => command({ kind: "pin", threadId: thread.id, pinned }),
    requestDelete: () => command({ kind: "request-delete", threadId: thread.id }),
  });
  const [isMenuOpen, setMenuOpen] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const { isPressing, handlers } = useIosLongPress(() => setMenuOpen(true), {
    enabled: isCompactViewport,
  });

  // Resting titles sit on the sidebar's own text ladder. The active row earns
  // the brighter accent foreground, while weight alone still carries unread.
  const title = (
    <span
      className={cn(
        "min-w-0 flex-1 truncate text-sm",
        isActive ? "text-sidebar-accent-foreground" : "text-sidebar-foreground",
        thread.isUnread && "font-medium",
      )}
    >
      {threadDisplayTitle(thread)}
    </span>
  );

  // The compact card is this one line. While the sheet is open it is drawn
  // twice: in the row, and as the inert copy lifted above the scrim.
  const compactRow = (interactive: boolean) => (
    <>
      {title}
      {hasStatusGlyph(thread.indicator) ? (
        <StatusGlyph indicator={thread.indicator} label={thread.indicatorLabel} />
      ) : null}
      <ActivityCounts activity={thread.activity} isCompactViewport />
      {pullRequest ? (
        <PullRequestNumber
          pullRequest={pullRequest}
          interactive={interactive}
          className={cn("z-[1]", interactive && "pointer-events-auto")}
        />
      ) : null}
      {showProviderIcon ? (
        <ProviderGlyph providerId={thread.providerId} provider={provider} />
      ) : null}
    </>
  );

  return (
    <RowContextMenu plan={plan} disabled={isCompactViewport}>
      <li className="list-none">
        <div
          ref={cardRef}
          {...handlers}
          className={cn(
            "group/card relative rounded-xl px-2.5 transition-all duration-150",
            isCompactViewport ? "min-h-10 py-0" : "rounded-md py-1.5 transition-colors",
            isActive ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60",
            // A thread open in another pane gets a weaker tint than the active
            // row, so the two states stay distinguishable.
            !isActive && isOpenInSplit && "bg-sidebar-accent/30",
            isPressing && "bg-sidebar-accent",
            isMenuOpen && "bg-sidebar-accent opacity-0",
          )}
        >
          {/* oxlint-disable-next-line jsx-a11y/anchor-is-valid -- must stay an
             anchor: the shortcut-target contract below and modifier-click
             split-open both depend on it. A button breaks each. */}
          <a
            // Both attributes, or bb's nine thread shortcuts stop finding rows.
            data-sidebar-thread-shortcut-target=""
            data-sidebar-thread-id={thread.id}
            href="#"
            aria-label={threadDisplayTitle(thread)}
            onPointerDown={onSplitPointerDown}
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
            className={cn(
              "absolute inset-0 cursor-pointer",
              isCompactViewport ? "rounded-xl" : "rounded-md",
            )}
          />
          {isCompactViewport ? (
            <CompactThreadActionMenu
              plan={plan}
              open={isMenuOpen}
              onOpenChange={setMenuOpen}
              anchorRef={cardRef}
              highlightContent={
                <div className="pointer-events-none relative flex h-full items-center gap-1.5 px-2.5">
                  {compactRow(false)}
                </div>
              }
            />
          ) : null}
          <div
            className={cn(
              "pointer-events-none relative flex items-center gap-1.5",
              isCompactViewport ? "h-10" : "h-5",
            )}
          >
            {isCompactViewport ? (
              compactRow(true)
            ) : (
              <DesktopThreadSummary title={title} thread={thread} now={now} plan={plan} />
            )}
          </div>
          {isCompactViewport ? null : (
            <ThreadMetadata
              thread={thread}
              provider={provider}
              projectName={projectName}
              branchName={branchName}
              pullRequest={pullRequest}
              showProviderIcon={showProviderIcon}
            />
          )}
        </div>
      </li>
    </RowContextMenu>
  );
});

function DesktopThreadSummary({
  title,
  thread,
  now,
  plan,
}: {
  title: ReactNode;
  thread: PluginSidebarThread;
  now: number;
  plan: ThreadActionPlan;
}) {
  const snoozeAction = findThreadAction(plan, "snooze-tomorrow");
  const settleAction = findThreadAction(plan, "settle");
  return (
    <>
      {title}
      {/* Status at rest, park actions on hover. Only the status
         yields, so the title never shifts. */}
      <span className="pointer-events-auto hidden items-center gap-0.5 group-hover/card:flex">
        {snoozeAction !== undefined ? (
          <ParkButton
            label={snoozeAction.label}
            icon={snoozeAction.icon}
            onActivate={snoozeAction.execute}
          />
        ) : null}
        {settleAction !== undefined ? (
          <ParkButton
            label={settleAction.label}
            icon={settleAction.icon}
            onActivate={settleAction.execute}
          />
        ) : null}
      </span>
      <span className={cn(STATUS_SLOT_CLASS, "group-hover/card:hidden")}>
        <StatusOrTime thread={thread} now={now} />
      </span>
    </>
  );
}

function ThreadMetadata({
  thread,
  provider,
  projectName,
  branchName,
  pullRequest,
  showProviderIcon,
}: {
  thread: PluginSidebarThread;
  provider?: ProviderGlyphInfo;
  projectName: string | null;
  branchName: string | null;
  pullRequest: PluginSidebarPullRequest | null;
  showProviderIcon: boolean;
}) {
  return (
    /* One step below the title, not half a step: at 10px the size drop
       alone does not carry the hierarchy, so the line also starts at the
       tint the provider glyph already uses. Segments that rank below the
       project dim further from here. */
    <div className="pointer-events-none relative mt-1 flex h-4 items-center gap-1.5 text-2xs text-muted-foreground/70">
      {/* The project holds its full name and the branch yields: which
         repository a thread belongs to outranks which branch it sits
         on, and the branch is the one that grows without bound. The
         wrapper is the flexible cell either way, so a card missing
         both still holds the line's right side still. */}
      <span className="flex min-w-0 flex-1 items-center gap-1">
        {projectName ? <span className="min-w-0 truncate">{projectName}</span> : null}
        {projectName && (branchName || thread.host) ? (
          <span aria-hidden className="shrink-0 text-muted-foreground/40">
            ·
          </span>
        ) : null}
        {/* Weighted rather than capped, so the project keeps its full
           name whenever the line has room for both and only starts
           truncating once this one has already given up everything.
           A thread without a worktree still runs somewhere, so the
           machine takes the branch's place rather than leaving the
           segment blank. */}
        {branchName ? (
          <span className="min-w-0 shrink-[9999] truncate font-mono text-muted-foreground/50">
            {branchName}
          </span>
        ) : thread.host ? (
          <span className="min-w-0 shrink-[9999] truncate text-muted-foreground/50">
            {thread.host.name}
          </span>
        ) : null}
      </span>
      <ActivityCounts activity={thread.activity} isCompactViewport={false} />
      {pullRequest ? <PullRequestNumber pullRequest={pullRequest} interactive /> : null}
      {/* Drawn for every card or for none, never per thread, so the line
         keeps a fixed right edge whichever way the setting is set. */}
      {showProviderIcon ? (
        <ProviderGlyph providerId={thread.providerId} provider={provider} />
      ) : null}
    </div>
  );
}

function ParkButton({
  label,
  icon,
  onActivate,
}: {
  label: string;
  icon: IconName;
  onActivate: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onActivate();
      }}
      className="rounded p-0.5 text-muted-foreground hover:text-foreground"
    >
      <Icon name={icon} className="size-3.5" />
    </button>
  );
}

/** The PR number in its state's tint; a link only where the row takes clicks. */
function PullRequestNumber({
  pullRequest,
  interactive,
  className,
}: {
  pullRequest: PluginSidebarPullRequest;
  interactive: boolean;
  className?: string;
}) {
  const classes = cn(
    "relative shrink-0 font-mono",
    className,
    pullRequest.state === "merged"
      ? "text-[color:var(--pr-merged)]"
      : pullRequest.attention === "checks_failed" || pullRequest.attention === "conflicts"
        ? "text-destructive-text"
        : pullRequest.attention === "ready_to_merge"
          ? "text-success-foreground"
          : "text-muted-foreground",
  );
  return interactive ? (
    <a
      href={pullRequest.url}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => event.stopPropagation()}
      title={pullRequest.title}
      className={cn(classes, "hover:underline")}
    >
      #{pullRequest.number}
    </a>
  ) : (
    <span className={classes}>#{pullRequest.number}</span>
  );
}

function ActivityCounts({
  activity,
  isCompactViewport,
}: {
  activity: PluginSidebarThread["activity"];
  isCompactViewport: boolean;
}) {
  return (
    <>
      {activity.workflows > 0 ? (
        <ActivityCount
          label="workflows"
          count={activity.workflows}
          isCompactViewport={isCompactViewport}
        />
      ) : null}
      {activity.backgroundAgents > 0 ? (
        <ActivityCount
          label="background agents"
          count={activity.backgroundAgents}
          isCompactViewport={isCompactViewport}
        />
      ) : null}
    </>
  );
}

function ActivityCount({
  label,
  count,
  isCompactViewport,
}: {
  label: string;
  count: number;
  isCompactViewport: boolean;
}) {
  return (
    <span
      aria-label={`${count} ${label}`}
      className={cn(
        "shrink-0 rounded bg-muted px-1 font-mono text-2xs",
        isCompactViewport ? "text-muted-foreground" : "text-muted-foreground/70",
      )}
    >
      {count}
    </span>
  );
}
