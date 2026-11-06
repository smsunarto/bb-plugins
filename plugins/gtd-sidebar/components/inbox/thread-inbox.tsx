import { SlidingDisclosure } from "./sliding-disclosure";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { DndContext, DragOverlay } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import {
  experimental_useProviders as useProviders,
  experimental_useRpcQuery as useRpcQuery,
  experimental_useSidebarThreads as useSidebarThreads,
  useBbNavigate,
  useSdk,
  useSettings,
  type PluginSidebarThread,
  type PluginThreadActionTarget,
  type PluginThreadListProps,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { cn } from "../../lib/utils";
import { Select, SelectContent, SelectItem, SelectValue } from "../ui/select";
import { ThreadCard } from "./thread-card";
import { SlimRow } from "./slim-row";
import type { ActiveThreadShelf, RowCommand } from "./thread-actions";
import { gtdSidebarRpcContract } from "../../lib/rpc-contract";
import { useCollapsedThreads } from "../../hooks/use-collapsed-threads";
import { useMachineVisibility } from "../../hooks/use-machine-visibility";
import { useNamingThreads } from "../../hooks/use-naming-threads";
import {
  useSidebarDrag,
  type SidebarDragApi,
  type SidebarProjectDrop,
} from "../../hooks/use-nest-drag";
import { usePortalScopeProps } from "../../lib/portal-scope";
import { useLifecycle, type LifecycleApi } from "../../hooks/use-lifecycle";
import { useHiddenWorkerActivity } from "../../hooks/use-hidden-worker-activity";
import { useSettledArchivePaging, useUnsettle } from "../../hooks/use-settled-threads";
import { useCommittedEvent } from "../../hooks/use-committed-event";
import { forgetSidebarActions, publishSidebarActions } from "../../lib/sidebar-actions-bridge";
import { toThreadActionTarget } from "../../lib/thread-action-target";
import { usePendingArchives } from "./pending-archives";
import { archiveAsksFirst, filterByProject, nextThreadIdAfterSettle } from "../../lib/inbox";
import {
  buildInboxTree,
  createShelfArrivals,
  nestDropAllowed,
  unnestDropAllowed,
  visibleInboxRows,
  type InboxShelf,
  type InboxThreadNode,
  type VisibleInboxRow,
} from "../../lib/inbox-tree";
import {
  applyProjectMove,
  groupCollapseKey,
  groupRowsByProject,
  groupStartsCollapsed,
  projectDropReorderArgs,
  projectReorderArgs,
  settleProjectOrderOverride,
  shouldGroupByProject,
  type ProjectGroup as ProjectGroupRows,
} from "../../lib/project-groups";
import { ProjectGroup, SortableProjectGroup } from "./project-group";
import { useBotsModel } from "../../bots/hooks/use-bots";
import { groupRowsByBot, type BotGroup as BotGroupRows } from "../../bots/lib/bot-groups";
import { BotGroup } from "../../bots/components/bot-group";
import { useBotsController } from "../../bots/components/bots-controller";
import {
  BotWorkflowRuns,
  WorkflowRunsContext,
  useWorkflowRunsData,
} from "../../bots/components/workflow-runs";
import { Icon } from "../ui/icon";
import { isShelvedThread } from "../../lib/settled-threads";
import { retainUnchangedThreads } from "../../lib/stable-threads";
import { useMinuteClock } from "../../hooks/use-minute-clock";
import { useRetained } from "../../hooks/use-retained";
import { resolveSidebarBranchLabel } from "../../lib/gitbutler";
import { filterHiddenMachines, sidebarMachines } from "../../lib/machines";
import { MachineVisibilityPicker, ScopeTrigger, scopeItemClassName } from "./machine-scope-picker";
import { MachineAppearanceProvider } from "./machine-appearance";
import { RenameProvider } from "./inline-rename";
import { CompactViewportOverrideProvider } from "../ui/hooks/use-compact-viewport";
import {
  useInboxWindow,
  type HeaderMeasureProps,
  type InboxWindow,
} from "../../hooks/use-inbox-window";
import {
  buildInboxWindow,
  encodeWindowedNav,
  estimateInboxItemSize,
  shelfKey,
  windowSegments,
} from "../../lib/inbox-window";

const ALL_PROJECTS = "__all__";
// The Settled shelf is a view of bb's archive, so the host list is asked for
// archived threads too; `isShelvedThread` cuts it to the shelf's window.
const SIDEBAR_LIFECYCLES = ["active", "archived"] as const;

const NO_THREADS: readonly PluginSidebarThread[] = [];
const EMPTY_STATE_CLASS = "px-2 py-6 text-center text-xs text-muted-foreground";
const GITBUTLER_REFRESH_MS = 30_000;
const MOBILE_SCROLL_FADE_STYLE: CSSProperties = {
  maskImage: "linear-gradient(to bottom, black 0, black calc(100% - 2rem), transparent 100%)",
  WebkitMaskImage: "linear-gradient(to bottom, black 0, black calc(100% - 2rem), transparent 100%)",
};

export function ThreadInbox(props: PluginThreadListProps) {
  const sdk = useSdk();
  // bb's silent title write, the one its own inline rename makes.
  const renameThread = useCallback(
    (threadId: string, title: string) => sdk.threads.update({ threadId, title }),
    [sdk],
  );
  // bb's slot prop, not a media query, decides compact for the vendored
  // registry hooks, so the rename editor and the rows agree.
  return (
    <CompactViewportOverrideProvider isCompactViewport={props.isCompactViewport}>
      <RenameProvider renameThread={renameThread}>
        <InboxList {...props} />
      </RenameProvider>
    </CompactViewportOverrideProvider>
  );
}

function InboxList({
  activeThreadId,
  isCompactViewport,
  onNavigate,
  searchQuery,
}: PluginThreadListProps) {
  const sidebar = useSidebarThreads({ experimental_lifecycles: SIDEBAR_LIFECYCLES });
  const { status, projects } = sidebar;
  const sidebarThreads = useStableThreads(useHiddenWorkerActivity(sidebar.threads));
  const now = useMinuteClock();
  const lifecycle = useLifecycle(sidebarThreads);
  const namingThreads = useNamingThreads();
  // The cut is made against the list's own clock, so a row ages off the shelf
  // while the sidebar sits open rather than on the next unrelated refresh.
  useSettledArchivePaging(sidebar, now);
  const threads = useMemo(
    () => sidebarThreads.filter((thread) => isShelvedThread(thread, now)),
    [now, sidebarThreads],
  );
  const unsettle = useUnsettle();
  // bb's own cached roster, so no glyph waits on a round trip of this plugin's.
  const { providers } = useProviders();
  const providerInfoById = useMemo(
    () => new Map(providers.map((provider) => [provider.id, provider])),
    [providers],
  );
  const [scope, setScope] = useState<string>(ALL_PROJECTS);
  const machines = useMemo(
    () => sidebarMachines(threads, sidebar.experimental_hosts),
    [threads, sidebar.experimental_hosts],
  );
  const visibility = useMachineVisibility(machines);
  // Optional enhancements stay off until the SDK confirms an explicit opt-in.
  const { values: settingValues, isLoading: settingsLoading } = useSettings();
  const repositoryGroupsEnabled = settingValues?.groupThreadsByProject !== false;

  const gitButlerLabels = useGitButlerLabels(threads, settingValues?.gitButlerBranches === true);

  const projectNameById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );
  // Threads without a project sit in bb's implicit personal project. Their
  // group trails the real projects in every shelf.
  const personalProjectIds = useMemo(
    () => new Set(projects.filter((project) => project.isPersonal).map((project) => project.id)),
    [projects],
  );
  // bb's project order — the same sortKey order `bb project list` reports —
  // with the personal project left out: it trails every shelf and bb refuses
  // to reorder it, so it is never a move anchor.
  const projectOrder = useMemo(
    () => projects.filter((project) => !project.isPersonal).map((project) => project.id),
    [projects],
  );
  // Bots and their bindings, joined to every listed thread (archived ones
  // too, so a settled child still knows its bot).
  const bots = useBotsModel(sidebarThreads);
  const { actions: botsActions, dialogs: botDialogs } = useBotsController(bots, onNavigate);
  const workflowRuns = useWorkflowRunsData(bots.bots.length > 0);
  // Only a shown bot claims its threads for the Bots shelf: a hidden bot's
  // conversations stay on their usual shelves until it wakes.
  const shelfBotOf = useMemo(() => {
    const shown = new Set(bots.shownBotIds);
    return (threadId: string) => {
      const botId = bots.ownerOf(threadId);
      return botId !== null && shown.has(botId) ? botId : null;
    };
  }, [bots]);
  const { tree, shelves, toggleThread, revealFamily } = useInboxTree(
    threads,
    lifecycle,
    scope,
    visibility.hiddenMachineIds,
    searchQuery,
    shelfBotOf,
  );
  const shelvedTotal = Object.values(shelves).reduce((total, rows) => total + rows.length, 0);
  const [botsShowingCompleted, setBotsShowingCompleted] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const toggleBotCompleted = useCommittedEvent((botId: string) =>
    setBotsShowingCompleted((current) => {
      const next = new Set(current);
      if (next.has(botId)) next.delete(botId);
      else next.add(botId);
      return next;
    }),
  );
  const searching = searchQuery.trim().length > 0;
  // An active machine filter keeps its repository header even when only one
  // repository remains. The header is the only visible repository identity on
  // a row, and is useful context when scanning one machine's work.
  const grouped = repositoryGroupsEnabled && (visibility.active || shouldGroupByProject(shelves));
  const { isGroupCollapsed, toggleGroup } = useCollapsedGroups();
  // A dropped group draws in its new slot before bb's write lands: the order
  // the drop predicts stands in for bb's until project-order-changed
  // republishes `projects`, when the real order replaces it.
  const [projectOrderOverride, setProjectOrderOverride] = useState<readonly string[] | null>(null);
  useEffect(() => setProjectOrderOverride(null), [projectOrder]);
  const orderedProjectIds = projectOrderOverride ?? projectOrder;
  // Only the Bots grouping reads the open thread, so navigation regroups it alone.
  const botShelfGroups = useMemo(
    () =>
      groupRowsByBot(shelves.bots, {
        botIds: bots.shownBotIds,
        ownerOf: shelfBotOf,
        isCompleted: bots.isCompleted,
        showCompleted: botsShowingCompleted,
        activeThreadId,
      }) as ProjectGroupRows[],
    [shelves.bots, bots, shelfBotOf, botsShowingCompleted, activeThreadId],
  );
  const projectShelfGroups = useMemo(() => {
    const groupsFor = (shelf: InboxShelf): ProjectGroupRows[] =>
      groupRowsByProject(shelves[shelf], orderedProjectIds, (projectId) =>
        personalProjectIds.has(projectId),
      );
    return {
      pinned: groupsFor("pinned"),
      nextAction: groupsFor("nextAction"),
      waiting: groupsFor("waiting"),
      slopcop: groupsFor("slopcop"),
      snoozed: groupsFor("snoozed"),
      settled: groupsFor("settled"),
    };
  }, [shelves, orderedProjectIds, personalProjectIds]);
  const groupedShelves = useMemo(
    () => ({ ...projectShelfGroups, bots: botShelfGroups }),
    [projectShelfGroups, botShelfGroups],
  );
  const { pinned, bots: botGroups, nextAction, waiting, slopcop } = groupedShelves;
  const { shelfViews, windowLayout, botsOpen, waitingOpen, slopcopOpen } = useShelfWindow(
    groupedShelves,
    grouped,
    searching,
    isGroupCollapsed,
    bots.list !== undefined,
  );
  // The rows the user can see, in the order they see them and tagged with the
  // shelf they sit under, so settling walks to the visible neighbour in its
  // own section and never into a folded group or another shelf.
  const visibleActiveRows = useMemo(
    () =>
      (
        [
          ["pinned", pinned],
          ["bots", botsOpen ? botGroups : []],
          ["nextAction", nextAction],
          ["waiting", waitingOpen ? waiting : []],
          ["slopcop", slopcopOpen ? slopcop : []],
        ] as const
      ).flatMap(([shelf, groups]) =>
        groups.flatMap((group) =>
          (grouped || shelf === "bots") &&
          !searching &&
          isGroupCollapsed(groupCollapseKey(shelf, group.projectId))
            ? []
            : group.rows.map((row) => ({ shelf, row })),
        ),
      ),
    [
      pinned,
      botGroups,
      botsOpen,
      nextAction,
      waiting,
      waitingOpen,
      slopcop,
      slopcopOpen,
      searching,
      grouped,
      isGroupCollapsed,
    ],
  );
  // A machine scope carries into the composer, which preselects that machine
  // for the new environment when it can host one.
  const navigate = useBbNavigate();
  const onNewThread = useCommittedEvent((projectId: string) => {
    const hostId = visibility.composerHostId;
    navigate.toCompose({
      projectId,
      focusPrompt: true,
      ...(hostId === undefined ? {} : { hostId }),
    });
    onNavigate();
  });
  const sdk = useSdk();
  // One drag context for both payloads (lib/sidebar-drag): a row onto a row
  // nests, a row onto a project header lifts it back out, and a group header
  // onto another group reorders its project. Desktop only: the compact
  // viewport has no drag.
  // Committed, not memoized on `threads`: a new roster must not hand every
  // row a new `drag` prop and redraw it.
  const titleFor = useCommittedEvent((threadId: string) => {
    const thread = threads.find((candidate) => candidate.id === threadId);
    return thread === undefined ? null : thread.displayTitle;
  });
  // The pointerup that ends a drag still fires click where it lands; the
  // guard below keeps that trailing click from folding a group or opening a
  // row the drag was dropped on.
  const lastDragEndAt = useRef(0);
  const onProjectDrop = useCommittedEvent(
    ({ projectId, overProjectId, edge }: SidebarProjectDrop) => {
      const args = projectDropReorderArgs(projectId, overProjectId, edge, orderedProjectIds);
      if (args === null) return;
      const optimistic = applyProjectMove(orderedProjectIds, projectId, args);
      setProjectOrderOverride(optimistic);
      // Settle from bb's canonical order too: it returns its current list for
      // an unchanged reorder but emits no project-order-changed event. bb
      // refuses to move the personal project; a group header never sends it,
      // so a rejection here is the host unreachable or the project gone, and
      // the shelf keeps bb's last order.
      const settle = (order: readonly string[] | null) => {
        setProjectOrderOverride((current) =>
          settleProjectOrderOverride(current, optimistic, order),
        );
      };
      void sdk.projects.reorder({ projectId, ...args }).then(
        (projects) => settle(projects.map((project) => project.id)),
        () => settle(null),
      );
    },
  );
  const onAnyDragEnd = useCommittedEvent(() => {
    lastDragEndAt.current = performance.now();
  });
  const sidebarDrag = useSidebarDrag({
    onNestedUnder: revealFamily,
    onProjectDrop,
    onAnyDragEnd,
  });
  const drag = isCompactViewport ? undefined : sidebarDrag.drag;
  const portalScope = usePortalScopeProps();
  const moveProject = useCommittedEvent(
    (projectId: string, direction: "up" | "down", shelfOrder: readonly string[]) => {
      const args = projectReorderArgs(projectId, direction, shelfOrder, orderedProjectIds);
      // bb republishes project-order-changed, which refetches the sidebar's
      // project list; no plugin publish needed.
      if (args !== null) {
        void sdk.projects.reorder({ projectId, ...args }).then(
          () => undefined,
          (error: unknown) => {
            toast.error(error instanceof Error ? error.message : "Couldn’t move the project.");
            return undefined;
          },
        );
      }
    },
  );
  const renderRow = (shelf: InboxShelf, row: VisibleInboxRow) => {
    const thread = row.node.thread;
    const branchName = resolveSidebarBranchLabel(
      thread.environment?.branchName ?? null,
      thread.environment?.id ?? null,
      gitButlerLabels,
    );
    if (shelf === "snoozed" || shelf === "settled") {
      return (
        <SlimRow
          isUnread={row.isUnread}
          isNaming={namingThreads.has(thread.id)}
          thread={thread}
          projectName={projectNameById.get(thread.projectId) ?? null}
          provider={providerInfoById.get(thread.providerId)}
          branchName={branchName}
          isActive={thread.id === activeThreadId}
          shelf={shelf}
          wakeAt={shelf === "snoozed" ? lifecycle.wakeAtFor(thread) : null}
          depth={row.depth}
          childCount={row.node.children.length}
          expanded={row.expanded}
          guides={row.guides}
          lastChild={row.lastChild}
          toggleThread={toggleThread}
          isCompactViewport={isCompactViewport}
          command={command}
        />
      );
    }
    const card = (
      <ThreadCard
        isUnread={row.isUnread}
        isNaming={namingThreads.has(thread.id)}
        thread={thread}
        shelf={shelf}
        provider={providerInfoById.get(thread.providerId)}
        depth={row.depth}
        parentId={row.parentId}
        parentTitle={row.parentTitle}
        childCount={row.node.children.length}
        expanded={row.expanded}
        guides={row.guides}
        lastChild={row.lastChild}
        statusThread={row.statusThread}
        toggleThread={toggleThread}
        projectName={projectNameById.get(thread.projectId) ?? null}
        branchName={branchName}
        isActive={thread.id === activeThreadId}
        canPark={canParkFamily(row.node, lifecycle)}
        isCompactViewport={isCompactViewport}
        command={command}
        drag={drag}
        dropAllowed={threadDropAllowed(drag, tree, thread.id)}
      />
    );
    return shelf === "bots" ? (
      <>
        {card}
        <BotWorkflowRuns
          threadId={thread.id}
          depth={row.depth}
          activeThreadId={activeThreadId}
          onNavigate={onNavigate}
        />
      </>
    ) : (
      card
    );
  };
  const renderRows = (
    shelf: InboxShelf,
    key: string,
    rows: readonly VisibleInboxRow[],
    gapFirst: boolean,
  ) => {
    const start = windowLayout.rowsStart.get(key);
    return start === undefined
      ? null
      : windowedRows(inboxWindow, start, rows, gapFirst, (row) => renderRow(shelf, row));
  };
  const renderBotGroups = (groups: readonly ProjectGroupRows[]) =>
    (groups as readonly BotGroupRows[]).map((group, index) => {
      const bot = bots.bots.find((entry) => entry.id === group.projectId);
      if (bot === undefined) return null;
      const key = groupCollapseKey("bots", group.projectId);
      return (
        <BotGroup
          key={group.projectId}
          bot={bot}
          threads={bots.threadsByBot.get(bot.id) ?? NO_THREADS}
          families={group.families}
          attention={group.attention}
          completed={group.completed}
          showCompleted={botsShowingCompleted.has(bot.id)}
          onToggleCompleted={() => toggleBotCompleted(bot.id)}
          expanded={searching || !isGroupCollapsed(key)}
          onToggle={() => toggleGroup(key)}
          actions={botsActions}
          canMoveUp={!isCompactViewport && index > 0}
          canMoveDown={!isCompactViewport && index < groups.length - 1}
          selected={activeThreadId !== null && bots.ownerOf(activeThreadId) === bot.id}
          isCompactViewport={isCompactViewport}
          measureRef={inboxWindow.measureRef}
          measureIndex={windowLayout.headerIndex.get(key)}
        >
          {renderRows("bots", key, group.rows, true)}
        </BotGroup>
      );
    });
  const renderGroups = (shelf: InboxShelf, groups: readonly ProjectGroupRows[]) => {
    if (shelf === "bots") return renderBotGroups(groups);
    const groupIds = groups.map((group) => group.projectId);
    // The shelf's sortable list is its groups that bb can reorder, in
    // rendered order: the personal project and any stale id are out — never
    // draggable, never a landing spot — while staying put where they render.
    const sortableIds = isCompactViewport
      ? []
      : groupIds.filter((projectId) => orderedProjectIds.includes(projectId));
    const renderGroup = (group: ProjectGroupRows) => {
      const key = groupCollapseKey(shelf, group.projectId);
      const Group = sortableIds.includes(group.projectId) ? SortableProjectGroup : ProjectGroup;
      return (
        <Group
          key={group.projectId}
          projectId={group.projectId}
          name={projectNameById.get(group.projectId) ?? "Unknown project"}
          families={group.families}
          attention={group.attention}
          expanded={searching || !isGroupCollapsed(key)}
          onToggle={() => toggleGroup(key)}
          onNewThread={onNewThread}
          {...projectMoveProps(
            group.projectId,
            groupIds,
            orderedProjectIds,
            isCompactViewport,
            moveProject,
          )}
          isCompactViewport={isCompactViewport}
          shelf={shelf}
          dropAllowed={projectDropAllowed(drag, tree, group.projectId)}
          measureRef={inboxWindow.measureRef}
          measureIndex={windowLayout.headerIndex.get(key)}
        >
          {renderRows(shelf, key, group.rows, true)}
        </Group>
      );
    };
    return grouped ? (
      <SortableContext id={shelf} items={sortableIds} strategy={verticalListSortingStrategy}>
        {groups.map(renderGroup)}
      </SortableContext>
    ) : (
      <ul className="flex flex-col">
        {renderRows(
          shelf,
          shelfKey(shelf),
          groups.flatMap((group) => group.rows),
          false,
        )}
      </ul>
    );
  };

  const scopeLabel =
    scope === ALL_PROJECTS ? "All projects" : (projectNameById.get(scope) ?? "All projects");

  // The ghost rides the pointer only for a dragged row; a dragged group
  // moves itself through the sortable's transform instead.
  const dragSource = sidebarDrag.drag.source;
  const dragGhostTitle = dragSource?.kind === "thread" ? titleFor(dragSource.threadId) : null;
  const pendingArchives = usePendingArchives();
  const command = useRowCommands({
    activeThreadId,
    onNavigate,
    lifecycle,
    unsettle,
    visibleActiveRows,
    threads: sidebar.threads,
    archive: pendingArchives.archive,
  });
  const scrollRef = useRef<HTMLDivElement>(null);
  const focusedRow = useFocusedRow();
  const inboxWindow = useInboxWindow({
    layout: windowLayout,
    scrollRef,
    estimateSize: (item) => estimateInboxItemSize(item, isCompactViewport),
    pinnedThreadIds: [
      activeThreadId,
      focusedRow.focusedThreadId,
      dragSource?.kind === "thread" ? dragSource.threadId : null,
    ],
  });

  return (
    <MachineAppearanceProvider
      localMachineId={settingValues?.localMachineId}
      settingsLoading={settingsLoading}
      knownMachines={sidebar.experimental_hosts}
    >
      {pendingArchives.runners}
      {botDialogs}
      <WorkflowRunsContext.Provider value={workflowRuns}>
        <DndContext {...sidebarDrag.contextProps}>
          <div
            data-gtd-sidebar-thread-list=""
            className="flex min-h-0 flex-1 flex-col"
            onClickCapture={(event) => {
              // A drag's trailing click must not act on what it lands on.
              if (performance.now() - lastDragEndAt.current < 200) {
                event.preventDefault();
                event.stopPropagation();
              }
            }}
          >
            <div className="flex shrink-0 items-center gap-1 px-2 pb-0.5">
              <Select value={scope} onValueChange={setScope}>
                {/* It sizes to its label, so the chevron sits beside it. The
                machine picker takes the slack. */}
                <ScopeTrigger
                  isCompactViewport={isCompactViewport}
                  className="min-w-0 flex-initial justify-start font-medium"
                  aria-label={`Project scope: ${scopeLabel}`}
                >
                  <SelectValue />
                </ScopeTrigger>
                <SelectContent>
                  <SelectItem
                    value={ALL_PROJECTS}
                    className={scopeItemClassName(isCompactViewport)}
                  >
                    All projects
                  </SelectItem>
                  {projects.map((project) => (
                    <SelectItem
                      key={project.id}
                      value={project.id}
                      className={scopeItemClassName(isCompactViewport)}
                    >
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <MachineVisibilityPicker
                machines={machines}
                visibility={visibility}
                onChange={visibility.change}
                isCompactViewport={isCompactViewport}
              />
            </div>

            <div
              ref={scrollRef}
              className={cn(
                "min-h-0 flex-1 overflow-y-auto px-1.5",
                isCompactViewport ? "pb-8" : "pb-2",
              )}
              // bb's compact footer overlays the list edge. Fade content into that
              // surface, while the matching padding lets the final row scroll clear.
              style={isCompactViewport ? MOBILE_SCROLL_FADE_STYLE : undefined}
              onFocus={focusedRow.onFocus}
              onBlur={focusedRow.onBlur}
            >
              <InboxContent
                status={status}
                // Until the saved machine choice loads, every machine counts as
                // visible, so painting early would flash hidden machines' rows.
                ready={
                  lifecycle.shelvesReady &&
                  visibility.ready &&
                  sidebar.experimental_archived?.status !== "loading"
                }
                count={shelvedTotal}
                // The Bots shelf keeps its header, and New bot, on an empty list.
                keepShelves={bots.list !== undefined}
                searchQuery={searchQuery}
              >
                {shelfViews.map(({ shelf, label, fold, showEmpty }) =>
                  groupedShelves[shelf].length > 0 || showEmpty === true ? (
                    <Shelf
                      key={label}
                      label={label}
                      count={shelf === "bots" ? groupedShelves.bots.length : shelves[shelf].length}
                      isCompactViewport={isCompactViewport}
                      fold={fold}
                      action={
                        shelf === "bots" ? (
                          <ShelfAction label="New bot" onClick={botsActions.createBot} />
                        ) : undefined
                      }
                      measureRef={inboxWindow.measureRef}
                      measureIndex={windowLayout.headerIndex.get(shelfKey(shelf))}
                    >
                      {renderGroups(shelf, groupedShelves[shelf])}
                    </Shelf>
                  ) : null,
                )}
              </InboxContent>
            </div>
          </div>
          {/* The ghost rides the pointer from document.body, clear of the list's
          scroll clip, so the rows themselves never shift under the drag. */}
          {createPortal(
            <div {...portalScope}>
              <DragOverlay dropAnimation={null}>
                {dragGhostTitle === null ? null : <NestDragGhost title={dragGhostTitle} />}
              </DragOverlay>
            </div>,
            document.body,
          )}
        </DndContext>
      </WorkflowRunsContext.Provider>
    </MachineAppearanceProvider>
  );
}

/** A shelf's collapse toggle: its open state and the click that flips it. */
interface ShelfFold {
  expanded: boolean;
  onToggle: () => void;
}

interface ShelfView {
  shelf: InboxShelf;
  label: string;
  /** Present on the shelves that fold; absent, the shelf always shows. */
  fold?: ShelfFold;
  /** Draw the header even with nothing on the shelf. */
  showEmpty?: boolean;
}

/**
 * The shelves in draw order, with the fold state of the ones that fold, and
 * the list window laid out over them.
 */
function useShelfWindow(
  groupedShelves: Record<InboxShelf, readonly ProjectGroupRows[]>,
  grouped: boolean,
  searching: boolean,
  isGroupCollapsed: (key: string) => boolean,
  /** Bots have loaded, so the Bots shelf shows even before the first bot. */
  botsReady: boolean,
) {
  const [showBots, setShowBots] = useState(true);
  const [showSnoozed, setShowSnoozed] = useState(false);
  const [showSettled, setShowSettled] = useState(false);
  // Waiting and SlopCop are the active shelves worth folding away: Waiting's
  // rows are work you cannot act on, SlopCop's are reviews no one asked for
  // in this list, and either can outnumber Next Action several times over.
  const [showWaiting, setShowWaiting] = useState(true);
  const [showSlopcop, setShowSlopcop] = useState(false);
  // Pinned and Next Action always show; the rest fold, and a search opens
  // them all.
  const botsOpen = showBots || searching;
  const waitingOpen = showWaiting || searching;
  const slopcopOpen = showSlopcop || searching;
  const snoozedOpen = showSnoozed || searching;
  const settledOpen = showSettled || searching;
  // Every shelf in the order it draws.
  const shelfViews: readonly ShelfView[] = [
    { shelf: "pinned", label: "Pinned" },
    {
      shelf: "bots",
      label: "Bots",
      fold: { expanded: botsOpen, onToggle: () => setShowBots((open) => !open) },
      showEmpty: botsReady && !searching,
    },
    { shelf: "nextAction", label: "Next Action" },
    {
      shelf: "waiting",
      label: "Waiting",
      fold: { expanded: waitingOpen, onToggle: () => setShowWaiting((open) => !open) },
    },
    {
      shelf: "slopcop",
      label: "SlopCop",
      fold: { expanded: slopcopOpen, onToggle: () => setShowSlopcop((open) => !open) },
    },
    {
      shelf: "snoozed",
      label: "Snoozed",
      fold: { expanded: snoozedOpen, onToggle: () => setShowSnoozed((open) => !open) },
    },
    {
      shelf: "settled",
      label: "Settled",
      fold: { expanded: settledOpen, onToggle: () => setShowSettled((open) => !open) },
    },
  ];
  const windowLayout = useMemo(
    () =>
      buildInboxWindow(
        [
          { shelf: "pinned", expanded: true, groups: groupedShelves.pinned },
          {
            shelf: "bots",
            expanded: botsOpen,
            groups: groupedShelves.bots,
            grouped: true,
            showEmpty: botsReady && !searching,
          },
          { shelf: "nextAction", expanded: true, groups: groupedShelves.nextAction },
          { shelf: "waiting", expanded: waitingOpen, groups: groupedShelves.waiting },
          { shelf: "slopcop", expanded: slopcopOpen, groups: groupedShelves.slopcop },
          { shelf: "snoozed", expanded: snoozedOpen, groups: groupedShelves.snoozed },
          { shelf: "settled", expanded: settledOpen, groups: groupedShelves.settled },
        ],
        grouped,
        (key) => searching || !isGroupCollapsed(key),
      ),
    [
      groupedShelves,
      botsOpen,
      botsReady,
      waitingOpen,
      slopcopOpen,
      snoozedOpen,
      settledOpen,
      grouped,
      searching,
      isGroupCollapsed,
    ],
  );
  return { shelfViews, windowLayout, botsOpen, waitingOpen, slopcopOpen };
}

/**
 * A container's rows, windowed: the rows in and near view mount in their
 * wrappers, and each run between them collapses into one placeholder as tall
 * as the rows it stands for. The placeholder lists those threads for bb's
 * next/previous-thread keys, which walk the rows in DOM order.
 */
function windowedRows(
  inboxWindow: InboxWindow,
  start: number,
  rows: readonly VisibleInboxRow[],
  gapFirst: boolean,
  renderRow: (row: VisibleInboxRow) => React.ReactNode,
) {
  return windowSegments(start, rows.length, inboxWindow.mounted).map((segment) => {
    if (segment.kind === "placeholder") {
      return (
        <li
          key={`placeholder:${segment.from}`}
          aria-hidden
          className="list-none"
          style={{ height: inboxWindow.span(start + segment.from, start + segment.to) }}
          data-sidebar-windowed-nav={encodeWindowedNav(rows.slice(segment.from, segment.to))}
        />
      );
    }
    const row = rows[segment.offset]!;
    return (
      <li
        key={row.node.thread.id}
        ref={inboxWindow.measureRef}
        data-index={start + segment.offset}
        data-gtd-row={row.node.thread.id}
        // The gap lives on the row, not the list, so a measured row carries
        // it and a placeholder can stand in for it exactly.
        className={cn("list-none", (gapFirst || segment.offset > 0) && "mt-0.5")}
      >
        {renderRow(row)}
      </li>
    );
  });
}

/**
 * The row holding focus, such as an open rename, so it stays mounted while
 * the list scrolls away from it. The handlers go on the scroll container.
 */
function useFocusedRow() {
  const [focusedThreadId, setFocusedThreadId] = useState<string | null>(null);
  const onFocus = (event: React.FocusEvent) => {
    const row = (event.target as Element).closest("[data-gtd-row]");
    setFocusedThreadId(row?.getAttribute("data-gtd-row") ?? null);
  };
  const onBlur = (event: React.FocusEvent) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setFocusedThreadId(null);
    }
  };
  return { focusedThreadId, onFocus, onBlur };
}

/** The tree's verdict on dropping the dragged row onto `threadId`; false between drags. */
function threadDropAllowed(
  drag: SidebarDragApi | undefined,
  tree: readonly InboxThreadNode[],
  threadId: string,
): boolean {
  const source = drag?.source;
  return source?.kind === "thread" && nestDropAllowed(tree, source.threadId, threadId);
}

/** A family can park only when every member can park. */
function canParkFamily(node: InboxThreadNode, lifecycle: LifecycleApi): boolean {
  const pending = [node];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (!lifecycle.canPark(current.thread)) return false;
    pending.push(...current.children);
  }
  return true;
}

/** Whether the dragged row may lift to `projectId`'s top level; false between drags. */
function projectDropAllowed(
  drag: SidebarDragApi | undefined,
  tree: readonly InboxThreadNode[],
  projectId: string,
): boolean {
  const source = drag?.source;
  return source?.kind === "thread" && unnestDropAllowed(tree, source.threadId, projectId);
}

/** The dragged row's stand-in under the pointer: its title on the accent ground. */
function NestDragGhost({ title }: { title: string }) {
  return (
    <div className="gtd-nest-ghost">
      <span className="gtd-thread-title text-sidebar-accent-foreground">{title}</span>
    </div>
  );
}

/**
 * The group header's Move up/down handlers, absent where the move cannot run:
 * edge groups, the personal project, and compact viewports (no right click).
 * Visibility is decided from this render's orders; the click itself recomputes
 * against the latest so a stale anchor never writes.
 */
function projectMoveProps(
  projectId: string,
  shelfOrder: readonly string[],
  projectOrder: readonly string[],
  isCompactViewport: boolean,
  moveProject: (projectId: string, direction: "up" | "down", shelfOrder: readonly string[]) => void,
): { onMoveUp?: () => void; onMoveDown?: () => void } {
  if (isCompactViewport) return {};
  const props: { onMoveUp?: () => void; onMoveDown?: () => void } = {};
  if (projectReorderArgs(projectId, "up", shelfOrder, projectOrder) !== null) {
    props.onMoveUp = () => moveProject(projectId, "up", shelfOrder);
  }
  if (projectReorderArgs(projectId, "down", shelfOrder, projectOrder) !== null) {
    props.onMoveDown = () => moveProject(projectId, "down", shelfOrder);
  }
  return props;
}

function useRowCommands({
  activeThreadId,
  onNavigate,
  lifecycle,
  unsettle,
  visibleActiveRows,
  threads,
  archive,
}: {
  activeThreadId: PluginThreadListProps["activeThreadId"];
  onNavigate: PluginThreadListProps["onNavigate"];
  lifecycle: LifecycleApi;
  unsettle: (threadId: string) => void;
  visibleActiveRows: readonly {
    shelf: ActiveThreadShelf;
    row: VisibleInboxRow;
  }[];
  threads: readonly PluginSidebarThread[];
  /** bb's own Archive for one thread, confirmation included. */
  archive: (thread: PluginThreadActionTarget) => void;
}) {
  const navigate = useBbNavigate();
  // bb's split placement rules, or a plain open; either one expands the
  // thread's conversation if a side panel had collapsed it.
  const openThread = useCommittedEvent((threadId: string, split = false) => {
    if (split) navigate.toThread(threadId, { split: true });
    else navigate.toThread(threadId);
  });
  // bb's archive sends the viewer to the compose screen once the mutation
  // resolves. Route changes commit inside a React transition, so against a
  // local server that lands before the neighbour's route does and wins. The
  // neighbour is therefore opened twice if need be: eagerly, and again from
  // this effect once the view has left the settled thread for nothing.
  const pendingAdvanceRef = useRef<{
    settledThreadId: string;
    nextThreadId: string;
    /** bb asked first, so the advance also waits for the list to drop the thread. */
    awaitsArchive: boolean;
  } | null>(null);
  useEffect(() => {
    const pending = pendingAdvanceRef.current;
    if (pending === null || activeThreadId === pending.settledThreadId) return;
    if (activeThreadId !== null) {
      pendingAdvanceRef.current = null;
      return;
    }
    // A cancelled confirmation leaves the thread live; an empty route is then
    // the composer opened by hand, not the archive landing, so stay put. The
    // route and the list refresh land in either order, so both are watched.
    if (
      pending.awaitsArchive &&
      threads.some((entry) => entry.id === pending.settledThreadId && !entry.isArchived)
    ) {
      return;
    }
    pendingAdvanceRef.current = null;
    openThread(pending.nextThreadId);
  }, [activeThreadId, threads, openThread]);

  const settle = useCommittedEvent((threadId: string) => {
    const settled = visibleActiveRows.find((entry) => entry.row.node.thread.id === threadId);
    if (settled !== undefined) {
      // The advance stays inside the settled row's own shelf, and skips its
      // subtree: bb's archive takes the children with it, so a descendant is
      // never a neighbour to land on.
      const cascaded = new Set<string>();
      const section: PluginSidebarThread[] = [];
      for (const entry of visibleActiveRows) {
        if (entry.shelf !== settled.shelf) continue;
        const parentId = entry.row.parentId;
        if (parentId !== null && (parentId === threadId || cascaded.has(parentId))) {
          cascaded.add(entry.row.node.thread.id);
        } else {
          section.push(entry.row.node.thread);
        }
      }
      const nextThreadId = nextThreadIdAfterSettle(section, threadId, activeThreadId);
      if (nextThreadId !== null) {
        const awaitsArchive = archiveAsksFirst(threads, threadId);
        pendingAdvanceRef.current = { settledThreadId: threadId, nextThreadId, awaitsArchive };
        // A parent waits on bb's confirmation, so only the effect above
        // advances, once the archive lands. A cancel leaves the user in place.
        if (!awaitsArchive) {
          openThread(nextThreadId);
          onNavigate();
        }
      }
    }
    archiveIfActive(threads, threadId, archive);
  });

  // The palette's settle row runs this same dispatcher, and a mounted list
  // is the only place it exists.
  useEffect(() => {
    const published = { settle };
    publishSidebarActions(published);
    return () => forgetSidebarActions(published);
  }, [settle]);

  const command = useCommittedEvent((command: RowCommand) => {
    switch (command.kind) {
      case "open":
        openThread(command.threadId, command.split);
        onNavigate();
        return;
      case "settle":
        settle(command.threadId);
        return;
      case "snooze":
        lifecycle.snooze(command.threadId, command.until);
        return;
      case "restore":
        if (command.shelf === "snoozed") lifecycle.unsnooze(command.threadId);
        else unsettle(command.threadId);
    }
  });

  return command;
}

/**
 * Settle is bb's archive. An archived thread's Archive entry is Unarchive, so
 * a thread already on the Settled shelf is left where it is.
 */
function archiveIfActive(
  threads: readonly PluginSidebarThread[],
  threadId: string,
  archive: (thread: PluginThreadActionTarget) => void,
): void {
  const thread = threads.find((entry) => entry.id === threadId);
  if (thread !== undefined && !thread.isArchived) archive(toThreadActionTarget(thread));
}

function useInboxTree(
  threads: readonly PluginSidebarThread[],
  lifecycle: LifecycleApi,
  scope: string,
  hiddenMachineIds: ReadonlySet<string>,
  searchQuery: string,
  botOf: (threadId: string) => string | null,
) {
  // Folded families are the backend's `expandedThreads` preference, kept
  // across reloads and windows. Folded project groups stay session state below.
  const familyIds = useMemo(() => {
    const listed = new Set(threads.map((thread) => thread.id));
    return [
      ...new Set(
        threads.flatMap((thread) =>
          thread.parentThreadId && listed.has(thread.parentThreadId) ? [thread.parentThreadId] : [],
        ),
      ),
    ];
  }, [threads]);
  const { collapsedThreads, toggleThread } = useCollapsedThreads(familyIds);
  // The arrival memory lives for the mount: a row keeps the place it earned
  // when it entered its shelf until the shelf itself changes.
  const [arrivals] = useState(createShelfArrivals);
  const tree = useMemo(
    () =>
      buildInboxTree(
        filterByProject(
          filterHiddenMachines(threads, hiddenMachineIds),
          scope === ALL_PROJECTS ? null : scope,
        ),
        (thread) => (lifecycle.shelfFor(thread) === "snoozed" ? "snoozed" : "active"),
        searchQuery,
        {
          arrivals,
          snoozedAtFor: lifecycle.snoozedAtFor,
          botOf,
        },
      ),
    [lifecycle, scope, hiddenMachineIds, searchQuery, threads, arrivals, botOf],
  );
  const shelves = useMemo(() => {
    const rows = (shelf: (typeof tree)[number]["shelf"]) =>
      visibleInboxRows(
        tree.filter((node) => node.shelf === shelf),
        collapsedThreads,
        searchQuery,
      );
    return {
      pinned: rows("pinned"),
      bots: rows("bots"),
      nextAction: rows("nextAction"),
      waiting: rows("waiting"),
      slopcop: rows("slopcop"),
      snoozed: rows("snoozed"),
      settled: rows("settled"),
    };
  }, [collapsedThreads, searchQuery, tree]);
  // A row dropped into a folded family would vanish; the drop opens it.
  const revealFamily = useCommittedEvent((threadId: string) => {
    if (collapsedThreads.has(threadId)) toggleThread(threadId);
  });
  return { tree, shelves, toggleThread, revealFamily };
}

/**
 * Folded project groups, keyed by shelf and project: folding bb-plugins in
 * Next Action leaves it open in Waiting. Session state on purpose — a fold is
 * a way to tidy the current scan, not a preference to carry across restarts.
 * The set holds the groups toggled away from their starting fold.
 */
function useCollapsedGroups() {
  const [toggled, setToggled] = useState<ReadonlySet<string>>(() => new Set());
  const toggleGroup = useCommittedEvent((key: string) => {
    setToggled((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  });
  const isGroupCollapsed = useMemo(
    () => (key: string) => toggled.has(key) !== groupStartsCollapsed(key),
    [toggled],
  );
  return { isGroupCollapsed, toggleGroup };
}

function useStableThreads(threads: readonly PluginSidebarThread[]): readonly PluginSidebarThread[] {
  const previous = useRef<readonly PluginSidebarThread[]>([]);
  return useMemo(() => {
    previous.current = retainUnchangedThreads(previous.current, threads);
    return previous.current;
  }, [threads]);
}

const NO_LABELS: ReadonlyMap<string, string> = new Map();

/**
 * GitButler's branch labels for plain checkouts, re-read on a fixed beat while
 * the list is open: a checkout's applied branches change without bb hearing
 * of it. A new set of checkouts keeps the last labels until its read lands,
 * and a failed read keeps them too; bb's own label remains the fallback.
 */
function useGitButlerLabels(
  threads: readonly PluginSidebarThread[],
  enabled: boolean,
): ReadonlyMap<string, string> {
  const environmentKey = useMemo(
    () =>
      [
        ...new Set(
          threads.flatMap((thread) => {
            const environment = thread.environment;
            // A worktree is bb's own branch; only a plain checkout can hold
            // GitButler's applied branches, and null means bb does not know yet.
            return environment?.isWorktree === false && environment.id !== null
              ? [environment.id]
              : [];
          }),
        ),
      ]
        .sort()
        .join("\u0000"),
    [threads],
  );
  const input = useMemo(
    () => ({ environmentIds: environmentKey ? environmentKey.split("\u0000") : [] }),
    [environmentKey],
  );
  const active = enabled && input.environmentIds.length > 0;
  const { data, refetch } = useRpcQuery({
    contract: gtdSidebarRpcContract,
    method: "listEnvironmentBranches",
    input,
    enabled: active,
  });
  const reread = useCommittedEvent(refetch);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void reread(), GITBUTLER_REFRESH_MS);
    return () => clearInterval(timer);
  }, [active, reread]);
  const labels = useRetained(active ? data : undefined);
  return useMemo(
    () =>
      active && labels !== undefined
        ? new Map(labels.environments.map(({ environmentId, label }) => [environmentId, label]))
        : NO_LABELS,
    [active, labels],
  );
}

/** Wait for plugin shelf reads before deciding whether the list is empty. */
function InboxContent({
  status,
  ready,
  count,
  keepShelves,
  searchQuery,
  children,
}: {
  status: ReturnType<typeof useSidebarThreads>["status"];
  ready: boolean;
  count: number;
  /** Draw the shelves above the empty message, for a shelf that shows empty. */
  keepShelves: boolean;
  searchQuery: string;
  children: React.ReactNode;
}) {
  if (status === "loading") return null;
  if (status === "error") {
    return <InboxStatus>Could not load threads.</InboxStatus>;
  }
  if (!ready) return null;
  if (count === 0) {
    const empty = (
      <InboxStatus>{searchQuery.trim() ? "No threads found" : "No threads yet"}</InboxStatus>
    );
    return keepShelves ? (
      <>
        {children}
        {empty}
      </>
    ) : (
      empty
    );
  }
  return children;
}

function InboxStatus({ children }: { children: React.ReactNode }) {
  return (
    // A status message is a polite live region, not a calculation result.
    // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
    <p role="status" className={EMPTY_STATE_CLASS}>
      {children}
    </p>
  );
}

/**
 * A shelf of full cards. Passing `fold` turns the header into a collapse
 * toggle; without it the header is a plain label and the rows always show.
 */
function Shelf({
  label,
  count,
  fold,
  action,
  children,
  isCompactViewport,
  measureRef,
  measureIndex,
}: {
  label: string;
  count: number;
  fold?: ShelfFold;
  /** A button at the header's end, such as Bots' New bot. */
  action?: React.ReactNode;
  children: React.ReactNode;
  isCompactViewport: boolean;
} & HeaderMeasureProps) {
  return (
    <section aria-label={label}>
      <ShelfHeader
        label={label}
        count={count}
        fold={fold}
        action={action}
        isCompactViewport={isCompactViewport}
        measureRef={measureRef}
        measureIndex={measureIndex}
      />
      {fold === undefined ? (
        children
      ) : (
        <SlidingDisclosure open={fold.expanded}>{children}</SlidingDisclosure>
      )}
    </section>
  );
}

/**
 * One header for every shelf, collapsible or not, so a folded Waiting reads
 * exactly like a folded Snoozed. The count only shows while the shelf is
 * closed, where it is the shelf's whole footprint.
 */
function ShelfHeader({
  label,
  count,
  fold,
  action,
  isCompactViewport,
  measureRef,
  measureIndex,
}: {
  label: string;
  count: number;
  fold?: ShelfFold;
  action?: React.ReactNode;
  isCompactViewport: boolean;
} & HeaderMeasureProps) {
  const mutedClass = isCompactViewport ? "text-muted-foreground" : "text-muted-foreground/70";
  const title = (
    <span className={cn("text-2xs font-medium", mutedClass)}>
      {fold?.expanded === false ? `${label} (${count})` : label}
    </span>
  );
  const rule = <span className="h-px flex-1 bg-sidebar-border" />;

  if (fold === undefined) {
    return (
      <h2
        ref={measureRef}
        data-index={measureIndex}
        className={cn(
          "gtd-shelf-header flex items-center gap-2 pr-2.5",
          isCompactViewport ? "min-h-10" : "pb-0.5 pt-2",
        )}
      >
        {title}
        {rule}
      </h2>
    );
  }

  // The heading owns the sticky pin and the list's measurement. The button
  // inside it reaches back over the heading's left inset (app.css), so it
  // stays the whole hit target.
  return (
    <h2 ref={measureRef} data-index={measureIndex} className="gtd-shelf-header group/shelf flex">
      <button
        type="button"
        onClick={fold.onToggle}
        aria-expanded={fold.expanded}
        // The folded count is the only sign of a fold; there is no chevron.
        // `cursor-pointer` is explicit because Tailwind v4's preflight gives a button `cursor: default`,
        // and the whole header is the hit target for collapsing the shelf.
        className={cn(
          "flex cursor-pointer items-center gap-2 pr-2.5 text-left",
          isCompactViewport ? "min-h-10" : "pb-0.5 pt-2",
        )}
      >
        {title}
        {rule}
      </button>
      {action}
    </h2>
  );
}

/** A shelf header's own action: an icon button revealed on hover or focus, always shown on touch. */
function ShelfAction({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="gtd-shelf-action"
    >
      <Icon name="Plus" className="size-3" />
    </button>
  );
}
