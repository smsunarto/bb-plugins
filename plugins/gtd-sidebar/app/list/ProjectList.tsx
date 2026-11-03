// GTD: bb's Thread list with its sections replaced by GTD shelves. bb's
// Pinned section stays as it is; Next Action, Waiting, SlopCop, Snoozed, and
// Settled follow, each a bb section whose project or machine groups are bb's
// own project rows and trees.
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { toast } from "sonner";
import type { SidebarThread } from "../model/sidebar-thread.js";
import { useBbNavigate, useSdk } from "@get-bb/plugin-sdk/app";
import {
  SidebarRenameProvider,
  useSidebarRename,
  useSidebarRenameState,
} from "../rows/SidebarInlineRename.js";
import { ThreadRowNavigationProvider } from "../rows/threadRowNavigation.js";
import {
  buildProjectThreadGroups,
  collectProjectThreadItemNavigationEntries,
  getProjectThreadItemDescendants,
  CHRONOLOGICAL_CONTAINER_ID,
  compareByCreatedAtDescending,
  compareStandardThreads,
  type ProjectThreadItem,
  type ThreadComparator,
} from "../model/project-thread-groups.js";
import { getCollapsedChildActivity } from "../model/thread-activity.js";
import { useSectionThreadDnd, PINNED_THREAD_PARENT_KEY } from "../dnd/useSectionThreadDnd.js";
import { useNestDropPreview } from "../dnd/useNestDropPreview.js";
import { getMutationErrorMessage } from "../ui/mutation-errors.js";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { ThreadListEmptyState } from "@/components/ui/thread-list-empty-state";
import { ActionMenuItem } from "@/components/ui/action-menu-items";
import {
  SidebarContentElementProvider,
  SidebarGroupContent,
  SidebarStickyStack,
} from "../ui/sidebar.js";
import { ProjectThreadTree } from "./ProjectRow.js";
import type { ProjectThreadListState } from "./ProjectRow.js";
import { buildPinnedSidebarState } from "../model/pinned-sidebar-threads.js";
import type { SidebarSectionId } from "../model/sidebar-section-id.js";
import { SortableProjectRow } from "./ProjectListProjects.js";
import { foldCount } from "../gtd/fold-count.js";
import { PinnedThreadTree, type PinnedThreadTreeProps } from "./PinnedThreadTree.js";
import { TopLevelSidebarSection } from "./TopLevelSidebarSection.js";
import type { ProjectActionsMenuSurface } from "./ProjectActionsMenu.js";
import {
  collapsedEnvironmentIdsAtom,
  groupFoldsAtom,
  shelfFoldsAtom,
  sidebarChronologicalSortAtom,
  sidebarGroupThreadsByEnvironmentAtom,
  sidebarSortDirectionAtom,
} from "../preferences/atoms.js";
import type {
  ChronologicalSort as SidebarChronologicalSort,
  ShelfId,
  SortDirection as SidebarSortDirection,
} from "../../shared/preferences.js";
import { usePreferencesReady } from "../preferences/PreferencesSync.js";
import { SidebarHeaderControls } from "./SidebarHeaderControls.js";
import { SortableSidebarSection } from "./BuiltInSidebarSection.js";
import { ThreadCreationPlacementScope } from "./ThreadCreationPlacement.js";
import { ReorderableSidebarSectionOrderList } from "./ReorderableSidebarSectionOrderList.js";
import { useReadStatusGrouping } from "./useReadStatusGrouping.js";
import { useSidebarThreadReveal, type ThreadRevealPath } from "./useSidebarThreadReveal.js";
import { SidebarDraftPresenceSync } from "./sidebarDraftPresence.js";
import { SidebarProjectsContext, type SidebarProject } from "../model/use-sidebar-data.js";
import {
  projectScopeAtom,
  useGtdShelves,
  type ProjectOrderPrediction,
} from "../gtd/useGtdShelves.js";
import { Button } from "@/components/ui/button";
import {
  NO_MACHINE_KEY,
  SHELF_LABELS,
  createArrivalComparator,
  type ShelfGroup,
  type ShelfView,
} from "../gtd/shelf-model.js";
import {
  groupFoldKey,
  groupStartsFolded,
  isGroupFolded,
  isShelfFolded,
  shelfStartsFolded,
  withFold,
} from "../gtd/folds.js";
import {
  forgetGtdListActions,
  publishGtdListActions,
  type GtdListActions,
} from "../gtd/gtd-actions.js";
import { GtdFilterProvider } from "../gtd/GtdFilters.js";
import { GtdShelfContext, GtdRowExtrasProvider } from "../gtd/row-extras.js";
import { useSettle } from "../gtd/useSettle.js";
import { useUnsettle } from "../../hooks/use-settled-threads.js";
import { snoozeUntilTomorrow } from "../../lib/lifecycle.js";
import {
  applyProjectMove,
  groupDropReorderArgs,
  projectReorderArgs,
} from "../../lib/project-groups.js";

export interface ProjectListProps {
  activeThreadId: string | null;
  onProjectSelect?: () => void;
}

type ToggleCollapsedId = (id: string) => void;
type OpenSidebarMenu = `displayOptions:${string}` | null;

const EMPTY_ITEMS: readonly ProjectThreadItem[] = [];
const NO_COLLAPSED_SECTIONS: ReadonlySet<string> = new Set();
/** The flat list's one entry in a shelf's drag order. */
const FLAT_TREE_ID = "threads" satisfies SidebarSectionId;

type ActiveRename = ReturnType<typeof useSidebarRenameState>;

function getThreadSortTitle(thread: SidebarThread, rename: ActiveRename): string {
  return rename?.kind === "thread" && rename.id === thread.id ? rename.name : thread.displayTitle;
}

function compareByTitleAscending(
  left: SidebarThread,
  right: SidebarThread,
  rename: ActiveRename = null,
): number {
  const titleDelta = getThreadSortTitle(left, rename).localeCompare(
    getThreadSortTitle(right, rename),
  );
  if (titleDelta !== 0) {
    return titleDelta;
  }

  return left.id.localeCompare(right.id);
}

function getProjectThreadItemAlphaLabel(
  item: ProjectThreadItem,
  rename: ActiveRename = null,
): string {
  switch (item.kind) {
    case "thread":
      return getThreadSortTitle(item.node.thread, rename);
    case "environment":
      return getThreadSortTitle(item.group.nodes[0].thread, rename);
    case "section":
      return rename?.kind === "section" && rename.id === item.group.id
        ? rename.name
        : item.group.name;
  }
}

function compareProjectThreadItemsByTitleAscending(
  left: ProjectThreadItem,
  right: ProjectThreadItem,
  rename: ActiveRename = null,
): number {
  const labelDelta = getProjectThreadItemAlphaLabel(left, rename).localeCompare(
    getProjectThreadItemAlphaLabel(right, rename),
  );
  if (labelDelta !== 0) {
    return labelDelta;
  }

  if (left.kind !== "section" && right.kind !== "section") {
    const leftThread = left.kind === "thread" ? left.node.thread : left.group.nodes[0].thread;
    const rightThread = right.kind === "thread" ? right.node.thread : right.group.nodes[0].thread;
    const threadIdDelta = leftThread.id.localeCompare(rightThread.id);
    if (threadIdDelta !== 0) {
      return threadIdDelta;
    }
  }

  const kindDelta = left.kind.localeCompare(right.kind);
  if (kindDelta !== 0) {
    return kindDelta;
  }

  return left.kind === "section" && right.kind === "section"
    ? left.group.key.localeCompare(right.group.key)
    : 0;
}

export function getSidebarThreadComparator(
  sort: Exclude<SidebarChronologicalSort, "arrival">,
  direction: SidebarSortDirection = "default",
  rename: ActiveRename = null,
): ThreadComparator {
  const normalizedSort = sort === "none" ? "updated" : sort;

  const multiplier =
    direction === "default" ||
    direction === (normalizedSort === "alpha" ? "ascending" : "descending")
      ? 1
      : -1;
  if (normalizedSort === "alpha") {
    const comparator: ThreadComparator = (left, right) =>
      multiplier * compareByTitleAscending(left, right, rename);
    comparator.compareItems = (left, right) =>
      multiplier * compareProjectThreadItemsByTitleAscending(left, right, rename);
    return comparator;
  }
  const base = normalizedSort === "created" ? compareByCreatedAtDescending : compareStandardThreads;
  return (left, right) => {
    const comparison = base(left, right);
    if (
      normalizedSort === "updated" &&
      (left.status === "active") !== (right.status === "active")
    ) {
      return comparison;
    }
    return multiplier * comparison;
  };
}

export function ProjectListNavigationLoadingState() {
  return (
    <div aria-label="Loading sidebar navigation" className="space-y-1.5 px-2 pt-1">
      <ProjectListNavigationLoadingRow textWidthClassName="w-2/3" />
      <ProjectListNavigationLoadingRow textWidthClassName="w-1/2" />
    </div>
  );
}

function ProjectListNavigationLoadingRow({ textWidthClassName }: { textWidthClassName: string }) {
  return (
    <div data-sidebar="navigation-loading-row" className="flex h-7 items-center gap-2 rounded-md">
      <Skeleton className="size-4 shrink-0 rounded-md bg-sidebar-border/60" />
      <Skeleton className={cn("h-3 rounded-sm bg-sidebar-border/50", textWidthClassName)} />
    </div>
  );
}

export function ProjectListShell({ children }: { children: ReactNode }) {
  return (
    <ThreadRowNavigationProvider>
      <SidebarContentElementProvider>
        <SidebarStickyStack data-sidebar-sticky-density="compact-actions">
          <SidebarGroupContent>{children}</SidebarGroupContent>
        </SidebarStickyStack>
      </SidebarContentElementProvider>
    </ThreadRowNavigationProvider>
  );
}

function buildGroupSectionItem(
  id: string,
  key: string,
  name: string,
  threads: readonly SidebarThread[],
  compareThreads: ThreadComparator,
  groupThreadsByEnvironment: boolean,
): Extract<ProjectThreadItem, { kind: "section" }> {
  const items = buildProjectThreadGroups(threads, compareThreads, groupThreadsByEnvironment);
  return {
    kind: "section",
    group: {
      id,
      key,
      name,
      items,
      threadCount: getProjectThreadItemDescendants(items).length,
      activity: getCollapsedChildActivity(threads),
    },
  };
}

interface GroupedModePinned {
  pinnedReorderPending: boolean;
  pinnedRootItems: PinnedThreadTreeProps["rootItems"];
  pinnedRootNodes: PinnedThreadTreeProps["rootNodes"];
  pinnedThreads: readonly SidebarThread[];
  onReorderPinnedThread: NonNullable<PinnedThreadTreeProps["onReorderPinnedRoot"]>;
}

const NO_PINNED: GroupedModePinned = {
  pinnedReorderPending: false,
  pinnedRootItems: EMPTY_ITEMS,
  pinnedRootNodes: [],
  pinnedThreads: [],
  onReorderPinnedThread: (_request, callbacks) => callbacks.onSettled(),
};

function useGroupedModeThreadDnd({
  collapsedThreadIds,
  compareThreads,
  onToggleThreadCollapsed,
  order,
  onOrderChange,
  pinned,
  rootItems,
  threads,
}: {
  collapsedThreadIds: Set<string>;
  compareThreads: ThreadComparator;
  onToggleThreadCollapsed: ToggleCollapsedId;
  order: readonly SidebarSectionId[];
  onOrderChange: (order: SidebarSectionId[]) => void;
  pinned: GroupedModePinned;
  rootItems: readonly ProjectThreadItem[];
  threads: readonly SidebarThread[];
}) {
  const expandThread = useCallback(
    (threadId: string) => {
      if (collapsedThreadIds.has(threadId)) {
        onToggleThreadCollapsed(threadId);
      }
    },
    [collapsedThreadIds, onToggleThreadCollapsed],
  );
  const threadDnd = useSectionThreadDnd({
    containerId: CHRONOLOGICAL_CONTAINER_ID,
    enabled: true,
    rootItems,
    topLevelSectionOrder: order,
    onTopLevelSectionOrderChange: onOrderChange,
    onExpandThread: expandThread,
    groups: true,
    keepPins: pinned === NO_PINNED,
    pinnedReorderPending: pinned.pinnedReorderPending,
    pinnedThreads: pinned.pinnedThreads,
    pinnedRootItems: pinned.pinnedRootItems,
    pinnedRootNodes: pinned.pinnedRootNodes,
    onReorderPinnedThread: pinned.onReorderPinnedThread,
  });
  return useNestDropPreview({
    compareThreads,
    pinnedRootNodes: pinned.pinnedRootNodes,
    sectionDnd: threadDnd,
    sections: [],
    threads,
  });
}

/** One shelf's trees: a flat list, or one item per group in draw order. */
interface ShelfItems {
  view: ShelfView;
  flat: readonly ProjectThreadItem[] | null;
  groups: readonly { group: ShelfGroup; item: Extract<ProjectThreadItem, { kind: "section" }> }[];
}

interface ShelfRenderState {
  collapsedThreadIds: Set<string>;
  collapsedEnvironmentIds: Set<string>;
  compareThreads: ThreadComparator;
  selectedThreadId?: string;
  onProjectSelect?: () => void;
  onToggleThreadCollapsed: ToggleCollapsedId;
  onToggleEnvironmentCollapsed: ToggleCollapsedId;
}

function MachineGroupSection({
  hostId,
  shelf,
  canRename,
  renderActions,
  ...props
}: ComponentProps<typeof SortableSidebarSection> & {
  hostId: string;
  /** The same machine heads a group on every shelf; one rename opens one editor. */
  shelf: string;
  canRename: boolean;
  renderActions: (renameActions?: {
    onRename: () => void;
    onCloseAutoFocus: (event: Event) => void;
  }) => ReactNode;
}) {
  const sdk = useSdk();
  const rename = useSidebarRename({
    kind: "machine",
    id: hostId,
    ownerKey: `${shelf}:machine:${hostId}`,
    name: props.label,
    label: "Machine name",
    maxLength: 100,
    onSave: (name) => sdk.hosts.update({ hostId, name }),
  });
  if (!canRename) return <SortableSidebarSection {...props} actions={renderActions()} />;
  return (
    <SortableSidebarSection
      {...props}
      disabled={props.disabled || rename.isEditing}
      labelEditor={rename.editor}
      onRename={rename.startEditingFromDoubleClick}
      actions={renderActions({
        onRename: rename.startEditingFromMenu,
        onCloseAutoFocus: rename.onCloseAutoFocus,
      })}
    />
  );
}

interface HeaderMenuOptions {
  /** Items below the shared Organize, Sort, and Filter entries. */
  menuItems?: ReactNode;
  onCloseAutoFocus?: (event: Event) => void;
  newThreadLast?: boolean;
}

/** A shelf header shows its menu first and New thread at the edge. */
const SHELF_HEADER_MENU: HeaderMenuOptions = { newThreadLast: true };

interface ShelfBodyProps extends ShelfRenderState {
  items: ShelfItems;
  projectsById: ReadonlyMap<string, SidebarProject>;
  hostNames: ReadonlyMap<string, string>;
  groupFolds: Readonly<Record<string, boolean | undefined>>;
  onToggleGroup: (shelf: ShelfId, groupKey: string) => void;
  onCreateThread: (target: { projectId?: string | null; hostId?: string }) => void;
  onReorderGroups: (shelfProjectIds: readonly string[], nextProjectIds: readonly string[]) => void;
  onMoveProject: (
    projectId: string,
    direction: "up" | "down",
    shelfProjectIds: readonly string[],
  ) => void;
  canReorderProject: (projectId: string) => boolean;
  renderMenu: (
    menuId: string,
    label: string,
    onNewThread: (() => void) | undefined,
    options?: HeaderMenuOptions,
  ) => ReactNode;
  isMenuOpen: (menuId: string) => boolean;
}

function ShelfBody({
  items,
  projectsById,
  hostNames,
  groupFolds,
  onToggleGroup,
  onCreateThread,
  onReorderGroups,
  onMoveProject,
  canReorderProject,
  renderMenu,
  isMenuOpen,
  ...state
}: ShelfBodyProps) {
  const { view, flat, groups } = items;
  const order = useMemo<SidebarSectionId[]>(
    () => (flat ? [FLAT_TREE_ID] : groups.map(({ group }) => group.key as SidebarSectionId)),
    [flat, groups],
  );
  const rootItems = useMemo<readonly ProjectThreadItem[]>(
    () => flat ?? groups.map(({ item }) => item),
    [flat, groups],
  );
  const shelfProjectIds = useMemo(
    () => groups.flatMap(({ group }) => (group.kind === "project" ? [group.id] : [])),
    [groups],
  );
  const handleOrderChange = useCallback(
    (next: SidebarSectionId[]) => {
      const nextProjectIds = next.flatMap((key) =>
        key.startsWith("project:") ? [key.slice("project:".length)] : [],
      );
      onReorderGroups(shelfProjectIds, nextProjectIds);
    },
    [onReorderGroups, shelfProjectIds],
  );
  const threadDnd = useGroupedModeThreadDnd({
    collapsedThreadIds: state.collapsedThreadIds,
    compareThreads: state.compareThreads,
    onToggleThreadCollapsed: state.onToggleThreadCollapsed,
    order,
    onOrderChange: handleOrderChange,
    pinned: NO_PINNED,
    rootItems,
    threads: view.threads,
  });
  const reorderable = shelfProjectIds.filter(canReorderProject);
  const toggleProject = useCallback(
    (projectId: string) => onToggleGroup(view.shelf, `project:${projectId}`),
    [onToggleGroup, view.shelf],
  );
  const createProjectThread = useCallback(
    (projectId: string) => onCreateThread({ projectId }),
    [onCreateThread],
  );
  const moveActions = useCallback(
    (projectId: string) => {
      const at = reorderable.indexOf(projectId);
      if (at < 0) return undefined;
      return (surface: ProjectActionsMenuSurface) => (
        <>
          <ActionMenuItem
            surface={surface}
            icon="ChevronUp"
            disabled={at === 0}
            onSelect={() => onMoveProject(projectId, "up", reorderable)}
          >
            Move up
          </ActionMenuItem>
          <ActionMenuItem
            surface={surface}
            icon="ChevronDown"
            disabled={at === reorderable.length - 1}
            onSelect={() => onMoveProject(projectId, "down", reorderable)}
          >
            Move down
          </ActionMenuItem>
        </>
      );
    },
    [onMoveProject, reorderable],
  );

  return (
    <ReorderableSidebarSectionOrderList order={order} threadDnd={threadDnd} className="space-y-0.5">
      {(sectionId, consumeClickSuppression) => {
        if (flat) {
          return (
            <ProjectThreadTree
              key={FLAT_TREE_ID}
              dndParentKey={CHRONOLOGICAL_CONTAINER_ID}
              rootItems={flat}
              threadListState={{ status: "ready", threads: view.threads }}
              compareThreads={state.compareThreads}
              selectedThreadId={state.selectedThreadId}
              collapsedThreadIds={state.collapsedThreadIds}
              collapsedEnvironmentIds={state.collapsedEnvironmentIds}
              onProjectSelect={state.onProjectSelect}
              onToggleThreadCollapsed={state.onToggleThreadCollapsed}
              onToggleEnvironmentCollapsed={state.onToggleEnvironmentCollapsed}
            />
          );
        }
        const entry = groups.find(({ group }) => group.key === sectionId);
        if (!entry) return null;
        const { group, item } = entry;
        const isCollapsed = isGroupFolded(groupFolds, view.shelf, group.key);
        const threadListState: ProjectThreadListState = { status: "ready", threads: group.threads };
        const project = group.kind === "project" ? projectsById.get(group.id) : undefined;
        if (project && !project.isPersonal) {
          return (
            <SortableProjectRow
              key={group.key}
              sortableId={group.key}
              tier="project"
              renameScope={`${view.shelf}:`}
              project={project}
              rootItems={item.group.items}
              threadListState={threadListState}
              selectedThreadId={state.selectedThreadId}
              isActive={false}
              isCollapsed={isCollapsed}
              collapsedThreadIds={state.collapsedThreadIds}
              collapsedEnvironmentIds={state.collapsedEnvironmentIds}
              compareThreads={state.compareThreads}
              onProjectSelect={state.onProjectSelect}
              onCreateProjectThread={createProjectThread}
              onToggleProjectCollapsed={toggleProject}
              onToggleThreadCollapsed={state.onToggleThreadCollapsed}
              onToggleEnvironmentCollapsed={state.onToggleEnvironmentCollapsed}
              reorderDisabled={reorderable.length < 2 || !reorderable.includes(group.id)}
              consumeProjectClickSuppression={consumeClickSuppression}
              extraActions={moveActions(group.id)}
            />
          );
        }
        const isMachine = group.kind === "machine";
        const label = isMachine
          ? group.id === NO_MACHINE_KEY
            ? "No machine"
            : (hostNames.get(group.id) ?? "Unknown machine")
          : (project?.name ?? "Unknown project");
        const menuId = `${view.shelf}:${group.key}`;
        const onNewThread = isMachine
          ? group.id === NO_MACHINE_KEY
            ? () => onCreateThread({})
            : () => onCreateThread({ hostId: group.id })
          : project
            ? () => onCreateThread({ projectId: project.id })
            : undefined;
        const sectionProps = {
          id: group.key as SidebarSectionId,
          tier: "project" as const,
          icon: isMachine ? "Globe" : "Folder",
          label,
          disabled: true,
          actionsOpen: isMenuOpen(menuId),
          actionsMobileAlways: true,
          collapsedActivity: item.group.activity,
          collapsedThreads: group.threads,
          foldCount: isCollapsed ? foldCount(group.threads) : undefined,
          collapseControl: {
            isCollapsed,
            onToggleCollapsed: () => onToggleGroup(view.shelf, group.key),
          },
          consumeClickSuppression,
          dropParentKey: group.key,
          children: (
            <ProjectThreadTree
              projectId={isMachine ? undefined : group.id}
              dndParentKey={group.key}
              rootItems={item.group.items}
              threadListState={threadListState}
              compareThreads={state.compareThreads}
              selectedThreadId={state.selectedThreadId}
              collapsedThreadIds={state.collapsedThreadIds}
              collapsedEnvironmentIds={state.collapsedEnvironmentIds}
              onProjectSelect={state.onProjectSelect}
              onToggleThreadCollapsed={state.onToggleThreadCollapsed}
              onToggleEnvironmentCollapsed={state.onToggleEnvironmentCollapsed}
            />
          ),
        };
        return (
          <div key={group.key} data-sidebar-sticky-project-item="">
            {isMachine ? (
              <MachineGroupSection
                {...sectionProps}
                hostId={group.id}
                shelf={view.shelf}
                canRename={hostNames.has(group.id)}
                renderActions={(renameActions) =>
                  renderMenu(menuId, label, onNewThread, {
                    menuItems: renameActions ? (
                      <ActionMenuItem
                        surface="dropdown"
                        icon="Edit"
                        onSelect={renameActions.onRename}
                      >
                        Rename
                      </ActionMenuItem>
                    ) : undefined,
                    onCloseAutoFocus: renameActions?.onCloseAutoFocus,
                  })
                }
              />
            ) : (
              <SortableSidebarSection
                {...sectionProps}
                actions={renderMenu(menuId, label, onNewThread)}
              />
            )}
          </div>
        );
      }}
    </ReorderableSidebarSectionOrderList>
  );
}

function PinnedShelf({
  pinnedState,
  pinnedThreads,
  isCollapsed,
  onToggleCollapsed,
  isReorderPending,
  onReorderPinnedRoot,
  actions,
  actionsOpen,
  ...state
}: ShelfRenderState & {
  pinnedState: ReturnType<typeof buildPinnedSidebarState>;
  pinnedThreads: readonly SidebarThread[];
  isCollapsed: boolean;
  onToggleCollapsed: () => void;
  isReorderPending: boolean;
  onReorderPinnedRoot: NonNullable<PinnedThreadTreeProps["onReorderPinnedRoot"]>;
  actions: ReactNode;
  actionsOpen: boolean;
}) {
  const pinnedRootThreads = useMemo(
    () => pinnedState.rootNodes.map((node) => node.thread),
    [pinnedState.rootNodes],
  );
  const threadDnd = useGroupedModeThreadDnd({
    collapsedThreadIds: state.collapsedThreadIds,
    compareThreads: state.compareThreads,
    onToggleThreadCollapsed: state.onToggleThreadCollapsed,
    order: PINNED_ORDER,
    onOrderChange: noop,
    pinned: {
      pinnedReorderPending: isReorderPending,
      pinnedRootItems: pinnedState.rootItems,
      pinnedRootNodes: pinnedState.rootNodes,
      pinnedThreads: pinnedRootThreads,
      onReorderPinnedThread: onReorderPinnedRoot,
    },
    rootItems: EMPTY_ITEMS,
    threads: pinnedThreads,
  });
  return (
    <ReorderableSidebarSectionOrderList order={PINNED_ORDER} threadDnd={threadDnd}>
      {(sectionId, consumeClickSuppression) => (
        <SortableSidebarSection
          key={sectionId}
          id="pinned"
          label={SHELF_LABELS.pinned}
          stickyHeader={false}
          disabled
          actions={actions}
          actionsOpen={actionsOpen}
          actionsMobileAlways
          collapsedActivity={getCollapsedChildActivity(pinnedThreads)}
          collapsedThreads={pinnedThreads}
          collapseControl={{ isCollapsed, onToggleCollapsed }}
          consumeClickSuppression={consumeClickSuppression}
          dropParentKey={PINNED_THREAD_PARENT_KEY}
        >
          <ThreadCreationPlacementScope group="pinned">
            <PinnedThreadTree
              rootItems={pinnedState.rootItems}
              rootNodes={pinnedState.rootNodes}
              selectedThreadId={state.selectedThreadId}
              collapsedThreadIds={state.collapsedThreadIds}
              collapsedEnvironmentIds={state.collapsedEnvironmentIds}
              onProjectSelect={state.onProjectSelect}
              onToggleThreadCollapsed={state.onToggleThreadCollapsed}
              onToggleEnvironmentCollapsed={state.onToggleEnvironmentCollapsed}
              isPinnedReorderPending={isReorderPending}
              onReorderPinnedRoot={onReorderPinnedRoot}
            />
          </ThreadCreationPlacementScope>
        </SortableSidebarSection>
      )}
    </ReorderableSidebarSectionOrderList>
  );
}

const PINNED_ORDER: SidebarSectionId[] = ["pinned"];
function noop() {}

function ProjectListComponent({ activeThreadId, onProjectSelect }: ProjectListProps) {
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const [prediction, setPrediction] = useState<ProjectOrderPrediction | null>(null);
  const gtd = useGtdShelves(prediction);
  const { data, layout, lifecycle } = gtd;
  const { projects, personalProject, hostsById } = data;
  const personalProjectId = personalProject?.id ?? null;
  const { bbProjectOrder, projectOrder: orderedProjectIds } = gtd;
  const preferencesReady = usePreferencesReady();
  const selectedThreadId = activeThreadId ?? undefined;
  const [isPinnedReorderPending, setIsPinnedReorderPending] = useState(false);
  const handleReorderPinnedRoot = useCallback<
    NonNullable<PinnedThreadTreeProps["onReorderPinnedRoot"]>
  >(
    (request, callbacks) => {
      setIsPinnedReorderPending(true);
      void sdk.threads
        .reorderPinned({
          threadId: request.itemId,
          previousThreadId: request.previousItemId,
          nextThreadId: request.nextItemId,
        })
        .catch((error: unknown) => {
          toast.error(
            getMutationErrorMessage({
              error,
              fallbackMessage: "Failed to reorder pinned thread.",
            }),
          );
        })
        .finally(() => {
          setIsPinnedReorderPending(false);
          callbacks.onSettled();
        });
    },
    [sdk],
  );
  const latestComposeTarget = useRef({ navigate, onProjectSelect });
  useLayoutEffect(() => {
    latestComposeTarget.current = { navigate, onProjectSelect };
  });
  // A machine filter that leaves one machine carries into the composer.
  const composerHostId = gtd.visibility.composerHostId;
  const createThread = useCallback(
    ({
      projectId = gtd.scope ?? personalProjectId,
      hostId = composerHostId,
      pinned = false,
    }: {
      projectId?: string | null;
      hostId?: string;
      pinned?: boolean;
    }) => {
      const target = latestComposeTarget.current;
      target.onProjectSelect?.();
      target.navigate.toCompose({
        ...(projectId !== null ? { projectId } : {}),
        placement: { sectionId: null, pinned },
        ...(hostId ? { hostId } : {}),
        focusPrompt: true,
      });
    },
    [composerHostId, gtd.scope, personalProjectId],
  );

  const [collapsedEnvironmentIdList, setCollapsedEnvironmentIdList] = useAtom(
    collapsedEnvironmentIdsAtom,
  );
  const [shelfFolds, setShelfFolds] = useAtom(shelfFoldsAtom);
  const [groupFolds, setGroupFolds] = useAtom(groupFoldsAtom);
  const [openSidebarMenu, setOpenSidebarMenu] = useState<OpenSidebarMenu>(null);
  const setSidebarMenuOpen = useCallback((menu: Exclude<OpenSidebarMenu, null>, open: boolean) => {
    setOpenSidebarMenu((current) => (open ? menu : current === menu ? null : current));
  }, []);
  const renderMenu = useCallback(
    (
      menuId: string,
      label: string,
      onNewThread: (() => void) | undefined,
      { menuItems, onCloseAutoFocus, newThreadLast }: HeaderMenuOptions = {},
    ) => {
      const id = `displayOptions:${menuId}` as const;
      return (
        <SidebarHeaderControls
          label={label}
          onNewThread={onNewThread}
          newThreadLast={newThreadLast}
          open={openSidebarMenu === id}
          onOpenChange={(open) => setSidebarMenuOpen(id, open)}
          onCloseAutoFocus={onCloseAutoFocus}
        >
          {menuItems}
        </SidebarHeaderControls>
      );
    },
    [openSidebarMenu, setSidebarMenuOpen],
  );
  const isMenuOpen = useCallback(
    (menuId: string) => openSidebarMenu === `displayOptions:${menuId}`,
    [openSidebarMenu],
  );
  const groupThreadsByEnvironment = useAtomValue(sidebarGroupThreadsByEnvironmentAtom);
  const chronologicalSort = useAtomValue(sidebarChronologicalSortAtom);
  const setChronologicalSort = useSetAtom(sidebarChronologicalSortAtom);
  const sortDirection = useAtomValue(sidebarSortDirectionAtom);
  const activeRename = useSidebarRenameState();
  const sortRename = chronologicalSort === "alpha" ? activeRename : null;
  const baseThreadComparator = useMemo<ThreadComparator>(
    () =>
      chronologicalSort === "arrival"
        ? createArrivalComparator(layout, sortDirection !== "ascending")
        : getSidebarThreadComparator(chronologicalSort, sortDirection, sortRename),
    [chronologicalSort, layout, sortDirection, sortRename],
  );
  const {
    comparator: compareThreads,
    collapsedThreadIds,
    toggleThreadCollapsed,
  } = useReadStatusGrouping({
    threads: gtd.visibleThreads,
    roster: gtd.threads,
    selectedThreadId,
    comparator: baseThreadComparator,
  });
  const collapsedEnvironmentIds = useMemo(
    () => new Set(collapsedEnvironmentIdList),
    [collapsedEnvironmentIdList],
  );
  useEffect(() => {
    if (chronologicalSort === "none") {
      setChronologicalSort("arrival");
    }
  }, [chronologicalSort, setChronologicalSort]);
  const toggleEnvironmentCollapsed = useCallback<ToggleCollapsedId>(
    (environmentId) => {
      setCollapsedEnvironmentIdList((current) =>
        current.includes(environmentId)
          ? current.filter((id) => id !== environmentId)
          : [...current, environmentId],
      );
    },
    [setCollapsedEnvironmentIdList],
  );
  const toggleShelf = useCallback(
    (shelf: ShelfId) => {
      setShelfFolds((current) =>
        withFold(current, shelf, !isShelfFolded(current, shelf), shelfStartsFolded(shelf)),
      );
    },
    [setShelfFolds],
  );
  const toggleGroup = useCallback(
    (shelf: ShelfId, groupKey: string) => {
      setGroupFolds((current) =>
        withFold(
          current,
          groupFoldKey(shelf, groupKey),
          !isGroupFolded(current, shelf, groupKey),
          groupStartsFolded(shelf),
        ),
      );
    },
    [setGroupFolds],
  );

  const pinnedState = useMemo(
    () =>
      buildPinnedSidebarState({
        groupEnvironmentThreads: groupThreadsByEnvironment,
        threads: [...gtd.pinnedThreads],
      }),
    [groupThreadsByEnvironment, gtd.pinnedThreads],
  );
  const projectsById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );
  const hostNames = useMemo(
    () => new Map([...hostsById.values()].map((host) => [host.id, host.name])),
    [hostsById],
  );
  const shelfItems = useMemo<ShelfItems[]>(
    () =>
      layout.shelves.map((view) => {
        if (!layout.grouped) {
          return {
            view,
            flat: buildProjectThreadGroups(view.threads, compareThreads, groupThreadsByEnvironment),
            groups: [],
          };
        }
        return {
          view,
          flat: null,
          groups: view.groups.map((group) => ({
            group,
            item: buildGroupSectionItem(
              group.id,
              group.key,
              group.id,
              group.threads,
              compareThreads,
              groupThreadsByEnvironment,
            ),
          })),
        };
      }),
    [compareThreads, groupThreadsByEnvironment, layout],
  );

  // The rows the user can see on one shelf, top to bottom: settle's advance
  // walks to the visible neighbour, never into a folded group or another shelf.
  const visibleRows = useCallback(
    (threadId: string): readonly string[] | null => {
      const context = {
        collapsedThreadIds,
        collapsedEnvironmentIds,
        collapsedSectionKeys: NO_COLLAPSED_SECTIONS,
      };
      const entries = (items: readonly ProjectThreadItem[]) =>
        items.flatMap((item) =>
          collectProjectThreadItemNavigationEntries(item, context).map((entry) => entry.threadId),
        );
      if (gtd.pinnedThreads.some((thread) => thread.id === threadId)) {
        return isShelfFolded(shelfFolds, "pinned") ? null : entries(pinnedState.rootItems);
      }
      const shelf = layout.shelfOf.get(threadId);
      const items = shelfItems.find((entry) => entry.view.shelf === shelf);
      if (shelf === undefined || items === undefined || isShelfFolded(shelfFolds, shelf)) {
        return null;
      }
      const rows = items.flat
        ? entries(items.flat)
        : items.groups.flatMap(({ group, item }) =>
            isGroupFolded(groupFolds, shelf, group.key) ? [] : entries(item.group.items),
          );
      return rows.includes(threadId) ? rows : null;
    },
    [
      collapsedEnvironmentIds,
      collapsedThreadIds,
      groupFolds,
      gtd.pinnedThreads,
      layout.shelfOf,
      pinnedState.rootItems,
      shelfFolds,
      shelfItems,
    ],
  );
  const { settle, runners } = useSettle({
    activeThreadId,
    threads: gtd.threads,
    visibleRows,
    onNavigate: onProjectSelect,
  });
  const unsettle = useUnsettle();

  // What bb's thread menus need to offer GTD's verbs, for every listed thread.
  const pinnedRootOf = useMemo(() => {
    const pinnedIds = new Set(gtd.pinnedThreads.map((thread) => thread.id));
    const parentOf = new Map(gtd.pinnedThreads.map((thread) => [thread.id, thread.parentThreadId]));
    const rootOf = new Map<string, string>();
    for (const thread of gtd.pinnedThreads) {
      let root = thread.id;
      const seen = new Set([root]);
      for (let parent = parentOf.get(root) ?? null; parent !== null && pinnedIds.has(parent);) {
        if (seen.has(parent)) break;
        seen.add(parent);
        root = parent;
        parent = parentOf.get(root) ?? null;
      }
      rootOf.set(thread.id, root);
    }
    return rootOf;
  }, [gtd.pinnedThreads]);
  const listActions = useMemo<GtdListActions>(() => {
    const shelfOf = new Map<string, ShelfId>(layout.shelfOf);
    const rootOf = new Map(layout.rootOf);
    for (const [threadId, rootId] of pinnedRootOf) {
      shelfOf.set(threadId, "pinned");
      rootOf.set(threadId, rootId);
    }
    const blocked = new Set<string>();
    for (const thread of gtd.visibleThreads) {
      const rootId = rootOf.get(thread.id);
      if (rootId !== undefined && !lifecycle.canPark(thread)) blocked.add(rootId);
    }
    const parkableRoots = new Set([...new Set(rootOf.values())].filter((id) => !blocked.has(id)));
    return {
      shelfOf,
      rootOf,
      parkableRoots,
      settle,
      unsettle,
      snooze: (rootThreadId) => lifecycle.snooze(rootThreadId, snoozeUntilTomorrow(new Date())),
      wake: (rootThreadId) => lifecycle.unsnooze(rootThreadId),
    };
  }, [gtd.visibleThreads, layout, lifecycle, pinnedRootOf, settle, unsettle]);
  useEffect(() => {
    publishGtdListActions(listActions);
    return () => forgetGtdListActions(listActions);
  }, [listActions]);

  const pathOf = useCallback(
    (threadId: string): ThreadRevealPath | null => {
      if (pinnedRootOf.has(threadId)) return { shelf: "pinned", groupKey: null };
      const shelf = layout.shelfOf.get(threadId);
      if (shelf === undefined) return null;
      return { shelf, groupKey: layout.grouped ? (layout.groupOf.get(threadId) ?? null) : null };
    },
    [layout, pinnedRootOf],
  );
  useSidebarThreadReveal({
    selectedThreadId,
    threads: gtd.visibleThreads,
    threadsReady: gtd.status === "ready" && gtd.ready,
    preferencesReady,
    pathOf,
  });

  const canReorderProject = useCallback(
    (projectId: string) => orderedProjectIds.includes(projectId),
    [orderedProjectIds],
  );
  const reorderProject = useCallback(
    (
      projectId: string,
      args: { previousProjectId: string | null; nextProjectId: string | null },
    ) => {
      const predicted = {
        from: bbProjectOrder,
        order: applyProjectMove(orderedProjectIds, projectId, args),
      };
      setPrediction(predicted);
      void sdk.projects.reorder({ projectId, ...args }).catch((error: unknown) => {
        setPrediction((current) => (current === predicted ? null : current));
        toast.error(
          getMutationErrorMessage({ error, fallbackMessage: "Couldn’t move the project." }),
        );
      });
    },
    [bbProjectOrder, orderedProjectIds, sdk],
  );
  const handleReorderGroups = useCallback(
    (shelfProjectIds: readonly string[], nextProjectIds: readonly string[]) => {
      const drop = groupDropReorderArgs(shelfProjectIds, nextProjectIds, orderedProjectIds);
      if (drop !== null) reorderProject(drop.projectId, drop.args);
    },
    [orderedProjectIds, reorderProject],
  );
  const handleMoveProject = useCallback(
    (projectId: string, direction: "up" | "down", shelfProjectIds: readonly string[]) => {
      const args = projectReorderArgs(projectId, direction, shelfProjectIds, orderedProjectIds);
      if (args !== null) reorderProject(projectId, args);
    },
    [orderedProjectIds, reorderProject],
  );

  const renderState: ShelfRenderState = {
    collapsedThreadIds,
    collapsedEnvironmentIds,
    compareThreads,
    selectedThreadId,
    onProjectSelect,
    onToggleThreadCollapsed: toggleThreadCollapsed,
    onToggleEnvironmentCollapsed: toggleEnvironmentCollapsed,
  };
  const setProjectScope = useSetAtom(projectScopeAtom);
  const filtersActive = gtd.scope !== null || gtd.visibility.hiddenMachineIds.size > 0;
  const clearFilters = () => {
    setProjectScope(null);
    if (gtd.visibility.hiddenMachineIds.size > 0) gtd.visibility.change({ kind: "all" });
  };
  const filters = useMemo(
    () => ({
      projects: projects.map((project) => ({ id: project.id, name: project.name })),
      scope: gtd.scope,
      machines: gtd.machines,
      hiddenMachineIds: gtd.visibility.hiddenMachineIds,
      changeMachines: gtd.visibility.change,
    }),
    [gtd.machines, gtd.scope, gtd.visibility.change, gtd.visibility.hiddenMachineIds, projects],
  );

  if (gtd.status === "loading" || !gtd.ready || !preferencesReady) {
    return (
      <ProjectListShell>
        <ProjectListNavigationLoadingState />
      </ProjectListShell>
    );
  }

  // bb keeps a snooze's row after a timer or activity wake, so only a thread
  // still on Snoozed counts down.
  const wakeAtFor = (thread: SidebarThread) =>
    lifecycle.shelfFor(thread) === "snoozed" ? lifecycle.wakeAtFor(thread) : null;
  const hasPinned = pinnedState.rootNodes.length > 0;
  const content = (
    <GtdFilterProvider value={filters}>
      {runners}
      <GtdRowExtrasProvider hosts={gtd.machines} wakeAtFor={wakeAtFor}>
        <ProjectListShell>
          <SidebarDraftPresenceSync />
          {!hasPinned && shelfItems.length === 0 ? (
            <>
              <ThreadListEmptyState
                message={gtd.status === "error" ? "Threads unavailable" : undefined}
                className="px-2 py-0.5"
              />
              {/* The filters live in shelf header menus, which an empty list
                  does not draw, so it offers its own way back. */}
              {filtersActive ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="mx-2 text-muted-foreground"
                  onClick={clearFilters}
                >
                  Clear filters
                </Button>
              ) : null}
            </>
          ) : (
            <div>
              {hasPinned ? (
                <PinnedShelf
                  {...renderState}
                  pinnedState={pinnedState}
                  pinnedThreads={gtd.pinnedThreads}
                  isCollapsed={isShelfFolded(shelfFolds, "pinned")}
                  onToggleCollapsed={() => toggleShelf("pinned")}
                  isReorderPending={isPinnedReorderPending}
                  onReorderPinnedRoot={handleReorderPinnedRoot}
                  actions={renderMenu(
                    "pinned",
                    SHELF_LABELS.pinned,
                    () => createThread({ pinned: true }),
                    SHELF_HEADER_MENU,
                  )}
                  actionsOpen={isMenuOpen("pinned")}
                />
              ) : null}
              {shelfItems.map((items) => {
                const { shelf, threads } = items.view;
                const label = SHELF_LABELS[shelf];
                return (
                  <GtdShelfContext.Provider key={shelf} value={shelf}>
                    <TopLevelSidebarSection
                      sectionId={`shelf:${shelf}`}
                      label={label}
                      actions={renderMenu(shelf, label, () => createThread({}), SHELF_HEADER_MENU)}
                      actionsOpen={isMenuOpen(shelf)}
                      actionsMobileAlways
                      collapsedActivity={getCollapsedChildActivity(threads)}
                      collapsedThreads={threads}
                      collapseControl={{
                        isCollapsed: isShelfFolded(shelfFolds, shelf),
                        onToggleCollapsed: () => toggleShelf(shelf),
                      }}
                    >
                      <ShelfBody
                        {...renderState}
                        items={items}
                        projectsById={projectsById}
                        hostNames={hostNames}
                        groupFolds={groupFolds}
                        onToggleGroup={toggleGroup}
                        onCreateThread={createThread}
                        onReorderGroups={handleReorderGroups}
                        onMoveProject={handleMoveProject}
                        canReorderProject={canReorderProject}
                        renderMenu={renderMenu}
                        isMenuOpen={isMenuOpen}
                      />
                    </TopLevelSidebarSection>
                  </GtdShelfContext.Provider>
                );
              })}
            </div>
          )}
        </ProjectListShell>
      </GtdRowExtrasProvider>
    </GtdFilterProvider>
  );
  return (
    <SidebarProjectsContext.Provider value={projects}>{content}</SidebarProjectsContext.Provider>
  );
}

export const ProjectList = memo(function ProjectList(props: ProjectListProps) {
  return (
    <SidebarRenameProvider>
      <ProjectListComponent {...props} />
    </SidebarRenameProvider>
  );
});
