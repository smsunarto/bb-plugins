import {
  memo,
  useRef,
  useState,
  type PointerEvent,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  experimental_useSidebarThreadPullRequest as useSidebarThreadPullRequest,
  experimental_useSidebarThreadSplit as useSidebarThreadSplit,
  type PluginSidebarPullRequest,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { Icon, type IconName } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { RowContextMenu } from "@/components/inbox/row-context-menu";
import { LIST_HOVER_TRANSITION } from "@/components/inbox/row-motion";
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
import { FadingText, ProjectChip, ThreadDetails } from "@/components/inbox/thread-details";
import { useRemoteMachine } from "@/components/inbox/machine-appearance";
import { threadDisplayTitle } from "@/lib/inbox";
import { snoozeUntilTomorrow } from "@/lib/lifecycle";
import { useIosLongPress } from "@/hooks/use-ios-long-press";
import { useCommittedEvent } from "@/hooks/use-committed-event";

interface ThreadCardProps {
  thread: PluginSidebarThread;
  shelf: ActiveThreadShelf;
  compactThreads: boolean;
  depth: number;
  parentId: string | null;
  parentProjectId: string | null;
  parentTitle: string | null;
  childCount: number;
  expanded: boolean;
  guides: string;
  lastChild: boolean;
  statusThread: PluginSidebarThread;
  toggleThread: (threadId: string) => void;
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
      isFocusedInSplit={layout?.panes.some((pane) => pane.isMe && pane.isFocused)}
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
  compactThreads,
  depth,
  parentId,
  parentProjectId,
  parentTitle,
  childCount,
  expanded,
  guides,
  lastChild,
  statusThread,
  toggleThread,
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
  isFocusedInSplit,
  onSplitPointerDown,
}: ThreadCardProps & {
  pullRequest: PluginSidebarPullRequest | null;
  isOpenInSplit: boolean;
  isFocusedInSplit: boolean | undefined;
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

  const compact = !isCompactViewport && (compactThreads || depth > 0);
  const showActions = shelf === "nextAction" || canPark;
  const relation = parentTitle
    ? `Child of ${parentTitle}`
    : childCount > 0
      ? `${childCount} subthreads`
      : undefined;
  const titleText = threadDisplayTitle(thread);

  const title = (
    <ThreadTitle
      title={titleText}
      isActive={isActive}
      isUnread={thread.isUnread}
      mobile={isCompactViewport}
    />
  );
  const mobileRow = (interactive: boolean) => (
    <MobileThreadSummary
      title={title}
      thread={thread}
      pullRequest={pullRequest}
      provider={provider}
      showProviderIcon={showProviderIcon}
      interactive={interactive}
    />
  );

  return (
    <RowContextMenu plan={plan} disabled={isCompactViewport}>
      <li className="list-none">
        <div
          ref={cardRef}
          data-sidebar-thread-focused={isFocusedInSplit}
          {...handlers}
          data-action-count={!isCompactViewport && showActions ? 2 : 0}
          {...threadCardPresentation({
            depth,
            childCount,
            isCompactViewport,
            compact,
            isActive,
            isOpenInSplit,
            isPressing,
            isMenuOpen,
          })}
        >
          <ThreadHierarchy
            threadId={thread.id}
            title={titleText}
            depth={depth}
            childCount={childCount}
            expanded={expanded}
            guides={guides}
            lastChild={lastChild}
            mobile={isCompactViewport}
            toggleThread={toggleThread}
          />
          <ThreadRowLink
            thread={thread}
            projectName={projectName}
            branchName={branchName}
            provider={provider}
            relation={relation}
            showDetails={compact}
            threadId={thread.id}
            title={titleText}
            shelf={shelf}
            isActive={isActive}
            mobile={isCompactViewport}
            parentId={parentId}
            childCount={childCount}
            expanded={expanded}
            toggleThread={toggleThread}
            onSplitPointerDown={onSplitPointerDown}
            command={command}
          />
          {isCompactViewport ? (
            <CompactThreadActionMenu
              plan={plan}
              open={isMenuOpen}
              onOpenChange={setMenuOpen}
              anchorRef={cardRef}
              highlightContent={
                <div className="pointer-events-none relative flex h-full items-center gap-1.5 px-2.5">
                  {mobileRow(false)}
                </div>
              }
            />
          ) : null}
          <div
            className={cn(
              "pointer-events-none relative flex items-center gap-1.5",
              summaryHeight(isCompactViewport, compact),
              !isCompactViewport && "gtd-summary",
            )}
          >
            {isCompactViewport ? (
              mobileRow(true)
            ) : (
              <DesktopThreadSummary
                title={
                  <DesktopTitle
                    compact={compact}
                    depth={depth}
                    parentProjectId={parentProjectId}
                    projectId={thread.projectId}
                    projectName={projectName}
                    host={thread.host}
                  >
                    {title}
                  </DesktopTitle>
                }
                thread={statusThread}
                now={now}
                plan={plan}
                compact={compact}
                showActions={showActions}
                canPark={canPark}
                activity={thread.activity}
                pullRequest={pullRequest}
              />
            )}
          </div>
          {isCompactViewport || compact ? null : (
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

function threadCardPresentation({
  depth,
  childCount,
  isCompactViewport,
  compact,
  isActive,
  isOpenInSplit,
  isPressing,
  isMenuOpen,
}: Pick<ThreadCardProps, "depth" | "childCount" | "isCompactViewport" | "isActive"> & {
  compact: boolean;
  isOpenInSplit: boolean;
  isPressing: boolean;
  isMenuOpen: boolean;
}) {
  return {
    style: {
      "--gtd-depth": depth,
      ...(isCompactViewport && (depth > 0 || childCount > 0)
        ? { paddingLeft: 24 + depth * 24 }
        : {}),
    } as CSSProperties,
    className: cn(
      "group/card relative rounded-xl px-2.5",
      !isCompactViewport && "gtd-thread-row",
      compact && "gtd-compact-row",
      LIST_HOVER_TRANSITION,
      isCompactViewport ? "min-h-10 py-0" : "rounded-md",
      isActive ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60",
      !isActive && isOpenInSplit && "bg-sidebar-accent/30",
      isPressing && "bg-sidebar-accent",
      isMenuOpen && "bg-sidebar-accent opacity-0",
    ),
  };
}

function summaryHeight(mobile: boolean, compact: boolean) {
  if (mobile) return "h-10";
  return compact ? "h-8" : "h-5";
}

function ThreadTitle({
  title,
  isActive,
  isUnread,
  mobile,
}: {
  title: string;
  isActive: boolean;
  isUnread: boolean;
  mobile: boolean;
}) {
  return (
    <span
      className={cn(
        "min-w-0 flex-1 text-sm",
        mobile ? "truncate" : "gtd-thread-title",
        isActive ? "text-sidebar-accent-foreground" : "text-sidebar-foreground",
        isUnread && "font-medium",
      )}
    >
      {mobile ? title : <FadingText text={title} />}
    </span>
  );
}

function MobileThreadSummary({
  title,
  thread,
  pullRequest,
  provider,
  showProviderIcon,
  interactive,
}: {
  title: ReactNode;
  thread: PluginSidebarThread;
  pullRequest: PluginSidebarPullRequest | null;
  provider?: ProviderGlyphInfo;
  showProviderIcon: boolean;
  interactive: boolean;
}) {
  return (
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
}

function ThreadHierarchy({
  threadId,
  title,
  depth,
  childCount,
  expanded,
  guides,
  lastChild,
  mobile,
  toggleThread,
}: {
  threadId: string;
  title: string;
  depth: number;
  childCount: number;
  expanded: boolean;
  guides: string;
  lastChild: boolean;
  mobile: boolean;
  toggleThread: (threadId: string) => void;
}) {
  const guideOffsets: number[] = [];
  for (let level = 0; level < guides.length; level++) {
    if (guides[level] === "1") guideOffsets.push(12 + level * 24);
  }
  return (
    <>
      {!mobile && depth > 0 ? (
        <span aria-hidden className="gtd-tree-guides">
          {guideOffsets.map((left) => (
            <span key={left} className="gtd-tree-line" style={{ left }} />
          ))}
          <span
            className={cn("gtd-tree-line", lastChild && "gtd-tree-line-last")}
            style={{ left: 12 + (depth - 1) * 24 }}
          />
          <span
            className="gtd-tree-elbow"
            style={{ left: 12 + (depth - 1) * 24, width: childCount > 0 ? 18 : 30 }}
          />
        </span>
      ) : null}
      {childCount > 0 ? (
        <button
          type="button"
          className="gtd-disclosure"
          aria-label={`${expanded ? "Collapse" : "Expand"} children of ${title}`}
          aria-expanded={expanded}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            toggleThread(threadId);
          }}
        >
          <Icon name="ChevronDown" className={cn("size-3", !expanded && "-rotate-90")} />
        </button>
      ) : null}
    </>
  );
}

function ThreadRowLink({
  thread,
  projectName,
  branchName,
  provider,
  relation,
  showDetails,
  threadId,
  title,
  shelf,
  isActive,
  mobile,
  parentId,
  childCount,
  expanded,
  toggleThread,
  onSplitPointerDown,
  command,
}: {
  thread: PluginSidebarThread;
  projectName: string | null;
  branchName: string | null;
  provider?: ProviderGlyphInfo;
  relation: string | undefined;
  showDetails: boolean;
  threadId: string;
  title: string;
  shelf: ActiveThreadShelf;
  isActive: boolean;
  mobile: boolean;
  parentId: string | null;
  childCount: number;
  expanded: boolean;
  toggleThread: (threadId: string) => void;
  onSplitPointerDown?: (event: PointerEvent<HTMLElement>) => void;
  command: DispatchRowCommand;
}) {
  return (
    <ThreadDetails
      thread={thread}
      projectName={projectName}
      branchName={branchName}
      provider={provider}
      relation={relation}
      enabled={showDetails}
    >
      {/* oxlint-disable-next-line jsx-a11y/anchor-is-valid -- must stay an
             anchor: the shortcut-target contract below and modifier-click
             split-open both depend on it. A button breaks each. */}
      <a
        // Both attributes, or bb's nine thread shortcuts stop finding rows.
        data-sidebar-thread-shortcut-target=""
        data-sidebar-thread-id={threadId}
        href="#"
        aria-label={title}
        aria-current={isActive ? "page" : undefined}
        onKeyDown={(event) => {
          let focusId: string | null = null;
          if (event.key === "ArrowRight" && childCount > 0) {
            event.preventDefault();
            if (!expanded) toggleThread(threadId);
            else {
              const rows = Array.from(
                event.currentTarget
                  .closest("ul")
                  ?.querySelectorAll<HTMLAnchorElement>("[data-sidebar-thread-id]") ?? [],
              );
              focusId =
                rows[rows.indexOf(event.currentTarget) + 1]?.dataset.sidebarThreadId ?? null;
            }
          } else if (event.key === "ArrowLeft") {
            event.preventDefault();
            if (expanded) toggleThread(threadId);
            else focusId = parentId;
          }
          if (focusId)
            Array.from(
              event.currentTarget
                .closest("ul")
                ?.querySelectorAll<HTMLAnchorElement>("[data-sidebar-thread-id]") ?? [],
            )
              .find((row) => row.dataset.sidebarThreadId === focusId)
              ?.focus();
        }}
        onPointerDown={onSplitPointerDown}
        onClick={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          command({
            kind: "open",
            threadId: threadId,
            shelf,
            split: event.metaKey || event.ctrlKey,
          });
        }}
        className={cn("absolute inset-0 cursor-pointer", mobile ? "rounded-xl" : "rounded-md")}
      />
    </ThreadDetails>
  );
}

function DesktopTitle({
  compact,
  depth,
  parentProjectId,
  projectId,
  projectName,
  host,
  children,
}: {
  compact: boolean;
  depth: number;
  parentProjectId: string | null;
  projectId: string;
  projectName: string | null;
  host: PluginSidebarThread["host"];
  children: ReactNode;
}) {
  const remote = useRemoteMachine(host);
  return (
    <>
      {compact && (remote || depth === 0 || parentProjectId !== projectId) ? (
        <ProjectChip name={projectName} host={host} />
      ) : null}
      {children}
    </>
  );
}

function DesktopThreadSummary({
  title,
  thread,
  now,
  plan,
  compact,
  showActions,
  canPark,
  activity,
  pullRequest,
}: {
  title: ReactNode;
  thread: PluginSidebarThread;
  now: number;
  plan: ThreadActionPlan;
  compact: boolean;
  showActions: boolean;
  canPark: boolean;
  activity: PluginSidebarThread["activity"];
  pullRequest: PluginSidebarPullRequest | null;
}) {
  const snoozeAction = findThreadAction(plan, "snooze-tomorrow");
  const settleAction = findThreadAction(plan, "settle");
  return (
    <>
      {title}
      <span className="gtd-rest-signals flex shrink-0 items-center gap-1.5">
        {compact ? <ActivityCounts activity={activity} isCompactViewport={false} /> : null}
        {compact && pullRequest ? (
          <PullRequestNumber pullRequest={pullRequest} interactive />
        ) : null}
        <span className={STATUS_SLOT_CLASS}>
          <StatusOrTime thread={thread} now={now} />
        </span>
      </span>
      {showActions ? (
        <span className="gtd-trailing-actions">
          <ParkButton
            label="Snooze"
            icon="Clock"
            disabled={!canPark}
            onActivate={() => snoozeAction?.execute()}
          />
          {settleAction ? (
            <ParkButton
              label={settleAction.label}
              icon={settleAction.icon}
              onActivate={settleAction.execute}
            />
          ) : null}
        </span>
      ) : null}
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
    <div className="gtd-thread-metadata pointer-events-none relative mt-1 flex h-4 items-center gap-1.5 text-2xs text-muted-foreground/70">
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
      <span className="gtd-rest-signals flex shrink-0 items-center gap-1.5">
        <ActivityCounts activity={thread.activity} isCompactViewport={false} />
        {pullRequest ? <PullRequestNumber pullRequest={pullRequest} interactive /> : null}
        {/* Drawn for every card or for none, never per thread, so the line
         keeps a fixed right edge whichever way the setting is set. */}
        {showProviderIcon ? (
          <ProviderGlyph providerId={thread.providerId} provider={provider} />
        ) : null}
      </span>
    </div>
  );
}

function ParkButton({
  label,
  icon,
  onActivate,
  disabled = false,
}: {
  label: string;
  icon: IconName;
  onActivate: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={disabled ? "Snooze is available when this thread is idle" : label}
      disabled={disabled}
      onPointerDown={(event) => {
        if (disabled || event.button > 0) return;
        event.preventDefault();
        event.stopPropagation();
        onActivate();
      }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (event.detail === 0) onActivate();
      }}
      className="flex size-6 items-center justify-center rounded text-muted-foreground hover:text-foreground disabled:opacity-35 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
