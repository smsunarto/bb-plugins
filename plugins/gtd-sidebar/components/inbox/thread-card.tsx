import {
  memo,
  useCallback,
  useRef,
  useState,
  type KeyboardEvent,
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
import { Icon, type IconName } from "../ui/icon";
import { cn } from "../../lib/utils";
import { RowContextMenu } from "./row-context-menu";
import { LIST_HOVER_TRANSITION } from "./row-motion";
import { CompactThreadActionMenu } from "./thread-action-menu";
import {
  buildThreadActionPlan,
  findThreadAction,
  type ActiveThreadShelf,
  type DispatchRowCommand,
  type ThreadActionPlan,
} from "./thread-actions";
import { ProviderGlyph, type ProviderGlyphInfo } from "./provider-glyph";
import { STATUS_SLOT_CLASS, StatusOrTime } from "./status-slot";
import { FadingText, HostLead, ThreadDetails } from "./thread-details";
import { threadDisplayTitle } from "../../lib/inbox";
import { snoozeUntilTomorrow } from "../../lib/lifecycle";
import { useIosLongPress } from "../../hooks/use-ios-long-press";
import { useCommittedEvent } from "../../hooks/use-committed-event";
import { useNestRow, type SidebarDragApi } from "../../hooks/use-nest-drag";

/** Horizontal step per nesting level, in px. Mirrors --gtd-depth-step in app.css. */
const DEPTH_STEP = 8;
/** The touch disclosure column: app.css `.gtd-disclosure-touch` width. */
const MOBILE_DISCLOSURE_WIDTH = 32;

interface ThreadCardProps {
  thread: PluginSidebarThread;
  shelf: ActiveThreadShelf;
  compactThreads: boolean;
  depth: number;
  parentId: string | null;
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
  isNaming?: boolean;
  /** False while the thread is working or blocked on the user. */
  canPark: boolean;
  /** The `showProviderIcon` setting, on by default. */
  showProviderIcon: boolean;
  isCompactViewport: boolean;
  command: DispatchRowCommand;
  /** Quantized clock, so every card in one render agrees on "now". */
  now: number;
  /** Sidebar drag state; absent on compact viewports, where there is no drag. */
  drag?: SidebarDragApi;
  /** Whether the row being dragged may drop here, per the tree's cycle guard. */
  dropAllowed: boolean;
}

export const ThreadCard = memo(function ThreadCard(props: ThreadCardProps) {
  const { splitProps, layout } = useSidebarThreadSplit(props.thread.id);
  const { pullRequest } = useSidebarThreadPullRequest(props.thread.id);
  const onSplitPointerDown = useCommittedEvent((event: PointerEvent<HTMLElement>) => {
    splitProps.onPointerDown?.(event);
  });
  // Drag source and drop target both; see use-nest-drag for how this shares
  // the anchor's pointerdown with bb's split gesture. Subscribed here, not in
  // the body, so dnd-kit's context churn re-runs this wrapper only: the body
  // sees committed handlers (dnd-kit rebuilds its listeners on every context
  // render) and two booleans.
  const nestRow = useNestRow(props.thread.id, props.dropAllowed, props.drag === undefined);
  const { setDragRef, setDropRef } = nestRow;
  const onNestPointerDown = useCommittedEvent((event: PointerEvent<HTMLElement>) => {
    nestRow.listeners?.onPointerDown?.(event);
  });
  const onNestKeyDown = useCommittedEvent((event: KeyboardEvent<HTMLElement>) => {
    nestRow.listeners?.onKeyDown?.(event);
  });
  const setNestRef = useCallback(
    (node: HTMLDivElement | null) => {
      setDragRef(node);
      setDropRef(node);
    },
    [setDragRef, setDropRef],
  );
  return (
    <ThreadCardBody
      {...props}
      pullRequest={pullRequest}
      isOpenInSplit={layout !== null}
      isFocusedInSplit={layout?.panes.some((pane) => pane.isMe && pane.isFocused)}
      onSplitPointerDown={splitProps.onPointerDown ? onSplitPointerDown : undefined}
      onNestPointerDown={onNestPointerDown}
      onNestKeyDown={onNestKeyDown}
      nestIsDragging={nestRow.isDragging}
      nestIsOver={nestRow.isOver}
      setNestRef={setNestRef}
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
  isNaming = false,
  canPark,
  showProviderIcon,
  isCompactViewport,
  command,
  now,
  drag,
  pullRequest,
  isOpenInSplit,
  isFocusedInSplit,
  onSplitPointerDown,
  onNestPointerDown,
  onNestKeyDown,
  nestIsDragging,
  nestIsOver,
  setNestRef,
}: ThreadCardProps & {
  pullRequest: PluginSidebarPullRequest | null;
  isOpenInSplit: boolean;
  isFocusedInSplit: boolean | undefined;
  onSplitPointerDown?: (event: PointerEvent<HTMLElement>) => void;
  onNestPointerDown: (event: PointerEvent<HTMLElement>) => void;
  onNestKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  nestIsDragging: boolean;
  nestIsOver: boolean;
  setNestRef: (node: HTMLDivElement | null) => void;
}) {
  const plan = buildThreadActionPlan({
    lifecycle: {
      kind: "active",
      canPark,
      snoozeUntilTomorrow: () =>
        command({ kind: "snooze", threadId: thread.id, until: snoozeUntilTomorrow(new Date()) }),
      settle: () => command({ kind: "settle", threadId: thread.id }),
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

  const setCardRef = (node: HTMLDivElement | null) => {
    cardRef.current = node;
    setNestRef(node);
  };

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
      isNaming={isNaming}
      isActive={isActive}
      isUnread={thread.isUnread}
      isChild={depth > 0}
      mobile={isCompactViewport}
    />
  );
  // The project lives in the group header above the row. The row leads with
  // the machine globe only when the thread runs elsewhere; a local title
  // starts straight after the disclosure column.
  const rowTitle = (
    <>
      <HostLead host={thread.host} />
      {title}
    </>
  );
  const mobileRow = (interactive: boolean) => (
    <MobileThreadSummary
      title={rowTitle}
      thread={statusThread}
      now={now}
      activity={thread.activity}
      pullRequest={pullRequest}
      interactive={interactive}
    />
  );

  return (
    <RowContextMenu thread={thread} command={command} plan={plan} disabled={isCompactViewport}>
      <li className="list-none">
        <div
          ref={setCardRef}
          data-sidebar-thread-active={isActive ? "true" : undefined}
          data-sidebar-thread-focused={isFocusedInSplit}
          {...handlers}
          data-action-count={!isCompactViewport && showActions ? 2 : 0}
          data-dragging={nestIsDragging ? "true" : undefined}
          data-drop-target={nestIsOver ? "true" : undefined}
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
            onNestPointerDown={onNestPointerDown}
            onNestKeyDown={onNestKeyDown}
            nestActive={drag?.source?.kind === "thread"}
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
                title={rowTitle}
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
      // A group slides its rows' leading edge right by --gtd-group-indent,
      // disclosure included; the content pays it back or the chevron lands
      // on the title. Ungrouped rows resolve the variable to 0 and keep the
      // same offsets as before.
      ...(isCompactViewport
        ? {
            paddingLeft:
              depth > 0 || childCount > 0
                ? `calc(${MOBILE_DISCLOSURE_WIDTH + 8 + depth * DEPTH_STEP}px + var(--gtd-group-indent, 0px))`
                : "calc(22px + var(--gtd-leaf-group-indent, 0px))",
          }
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
  isNaming,
  isActive,
  isUnread,
  isChild,
  mobile,
}: {
  title: string;
  isNaming: boolean;
  isActive: boolean;
  isUnread: boolean;
  isChild: boolean;
  mobile: boolean;
}) {
  // A read child sits at the slim-row tone so it reads as secondary to its
  // parent; unread children keep full color and weight so attention pops.
  const muted = isChild && !isActive && !isUnread;
  return (
    <span
      data-gtd-naming={isNaming || undefined}
      aria-busy={isNaming || undefined}
      className={cn(
        "gtd-thread-title min-w-0 flex-1",
        mobile && "gtd-mobile-title",
        isActive
          ? "text-sidebar-accent-foreground"
          : muted
            ? mobile
              ? "text-muted-foreground"
              : "text-muted-foreground/70"
            : "text-sidebar-foreground",
        isUnread && "font-medium",
      )}
    >
      <FadingText text={title} />
    </span>
  );
}

/**
 * The compact viewport's row: the same line a compact desktop row draws,
 * project chip, title, then activity, PR and status-or-age, minus the hover
 * affordances a touch screen cannot reach. The long-press menu stands in for
 * the tooltip and the trailing actions.
 */
function MobileThreadSummary({
  title,
  thread,
  now,
  activity,
  pullRequest,
  interactive,
}: {
  title: ReactNode;
  thread: PluginSidebarThread;
  now: number;
  activity: PluginSidebarThread["activity"];
  pullRequest: PluginSidebarPullRequest | null;
  interactive: boolean;
}) {
  return (
    <>
      {title}
      <span className="gtd-rest-signals flex shrink-0 items-center gap-1.5">
        <ActivityCounts activity={activity} isCompactViewport />
        {pullRequest ? (
          <PullRequestNumber
            pullRequest={pullRequest}
            interactive={interactive}
            className={cn("z-[1]", interactive && "pointer-events-auto")}
          />
        ) : null}
        <span className={STATUS_SLOT_CLASS}>
          <StatusOrTime thread={thread} now={now} />
        </span>
      </span>
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
    if (guides[level] === "1") guideOffsets.push(12 + level * DEPTH_STEP);
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
            style={{ left: 12 + (depth - 1) * DEPTH_STEP }}
          />
          <span
            className="gtd-tree-elbow"
            style={{
              left: 12 + (depth - 1) * DEPTH_STEP,
              // Stop short of the child's chevron glyph, or 10px short of a
              // leaf's title, so the elbow never touches what it points at.
              width: childCount > 0 ? DEPTH_STEP - 6 : DEPTH_STEP + 6,
            }}
          />
        </span>
      ) : null}
      {childCount > 0 ? (
        <button
          type="button"
          className={cn("gtd-disclosure", mobile && "gtd-disclosure-touch")}
          aria-label={`${expanded ? "Collapse" : "Expand"} children of ${title}`}
          aria-expanded={expanded}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            toggleThread(threadId);
          }}
        >
          <Icon
            name="ChevronDown"
            className={cn(mobile ? "size-4" : "size-3", !expanded && "-rotate-90")}
          />
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
  onNestPointerDown,
  onNestKeyDown,
  nestActive,
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
  /** dnd-kit's activators for the nest drag; no-ops where drags are off. */
  onNestPointerDown: (event: PointerEvent<HTMLElement>) => void;
  onNestKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  /** A nest drag is live somewhere in the list. */
  nestActive: boolean;
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
          // Space picks the row up (see use-nest-drag); while a drag is live
          // the arrows move the pick, not the fold.
          onNestKeyDown(event);
          if (nestActive) return;
          const tree =
            event.currentTarget.closest("[data-sidebar-thread-tree]") ??
            event.currentTarget.closest("ul");
          const rows = Array.from(
            tree?.querySelectorAll<HTMLAnchorElement>("[data-sidebar-thread-id]") ?? [],
          );
          let focusId: string | null = null;
          if (event.key === "ArrowRight" && childCount > 0) {
            event.preventDefault();
            if (!expanded) toggleThread(threadId);
            else {
              focusId =
                rows[rows.indexOf(event.currentTarget) + 1]?.dataset.sidebarThreadId ?? null;
            }
          } else if (event.key === "ArrowLeft") {
            event.preventDefault();
            if (expanded) toggleThread(threadId);
            else focusId = parentId;
          }
          if (focusId) rows.find((row) => row.dataset.sidebarThreadId === focusId)?.focus();
        }}
        onPointerDown={(event) => {
          // Both gestures start here; the destination decides which one lands.
          onNestPointerDown(event);
          onSplitPointerDown?.(event);
        }}
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
