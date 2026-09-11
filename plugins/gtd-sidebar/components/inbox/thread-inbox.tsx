import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  experimental_useProviders as useProviders,
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  experimental_useSidebarThreads as useSidebarThreads,
  useBbNavigate,
  useRpc,
  useSettings,
  type PluginSidebarThread,
  type PluginThreadListProps,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ThreadCard } from "@/components/inbox/thread-card";
import { SlimRow } from "@/components/inbox/slim-row";
import type { RowCommand } from "@/components/inbox/thread-actions";
import type { gtdSidebarRpcContract } from "@/server";
import { useLifecycle, type LifecycleApi } from "@/hooks/use-lifecycle";
import { useSettledThreads, type SettledThreadsApi } from "@/hooks/use-settled-threads";
import { useCommittedEvent } from "@/hooks/use-committed-event";
import { forgetSidebarActions, publishSidebarActions } from "@/lib/sidebar-actions-bridge";
import { TRAILING_GLYPH_BOX_CLASS } from "@/components/inbox/status-slot";
import { filterByProject, nextThreadIdAfterSettle } from "@/lib/inbox";
import {
  buildInboxTree,
  visibleInboxRows,
  type InboxShelf,
  type VisibleInboxRow,
} from "@/lib/inbox-tree";
import {
  groupCollapseKey,
  groupRowsByProject,
  shouldGroupByProject,
  type ProjectGroup as ProjectGroupRows,
} from "@/lib/project-groups";
import { ProjectGroup } from "@/components/inbox/project-group";
import { mergeSettledThreads } from "@/lib/settled-threads";
import { gitButlerLabelsMatch, resolveSidebarBranchLabel } from "@/lib/gitbutler";
import { filterByMachine, sidebarMachines } from "@/lib/machines";
import { MachineScopePicker } from "@/components/inbox/machine-scope-picker";
import { MachineAppearanceProvider } from "@/components/inbox/machine-appearance";

const ALL_PROJECTS = "__all__";

const EMPTY_STATE_CLASS = "px-2 py-6 text-center text-xs text-muted-foreground";
const GITBUTLER_REFRESH_MS = 30_000;
const MOBILE_SCROLL_FADE_STYLE: CSSProperties = {
  maskImage: "linear-gradient(to bottom, black 0, black calc(100% - 2rem), transparent 100%)",
  WebkitMaskImage: "linear-gradient(to bottom, black 0, black calc(100% - 2rem), transparent 100%)",
};

export function ThreadInbox({
  activeThreadId,
  isCompactViewport,
  onNavigate,
  searchQuery,
}: PluginThreadListProps) {
  const { status, threads: hostThreads, projects } = useSidebarThreads();
  const now = useMinuteClock();
  const lifecycle = useLifecycle();
  // bb's view never carries an archived thread, so the Settled shelf's rows
  // come from a second read and are merged in before anything partitions.
  const settledThreads = useSettledThreads(now);
  const threads = useMemo(
    () => mergeSettledThreads(hostThreads, settledThreads.threads),
    [hostThreads, settledThreads.threads],
  );
  // bb's own cached roster, so no glyph waits on a round trip of this plugin's.
  const { providers } = useProviders();
  const providerInfoById = useMemo(
    () => new Map(providers.map((provider) => [provider.id, provider])),
    [providers],
  );
  const [scope, setScope] = useState<string>(ALL_PROJECTS);
  const [machineScope, setMachineScope] = useState<string | null>(null);
  const machines = sidebarMachines(threads);
  // Read once here rather than per card, and compared against `false` rather
  // than coerced: `values` is undefined while the settings load, and the
  // setting is on by default, so anything that is not an explicit "off" draws
  // the glyph. That way the common case never flashes it on and off.
  const { values: settingValues } = useSettings();
  const showProviderIcon = settingValues?.showProviderIcon !== false;
  const compactThreads = settingValues?.compactThreads === true;

  const gitButlerLabels = useGitButlerLabels(threads);

  const [showSnoozed, setShowSnoozed] = useState(false);
  const [showSettled, setShowSettled] = useState(false);
  // Waiting is the one active shelf worth folding away: its rows are work you
  // cannot act on, and they can outnumber Next Action several times over.
  const [showWaiting, setShowWaiting] = useState(true);

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

  const { shelves, toggleThread } = useInboxTree(
    threads,
    lifecycle,
    scope,
    machineScope,
    searchQuery,
  );
  const shelvedTotal = Object.values(shelves).reduce((total, rows) => total + rows.length, 0);
  const searching = searchQuery.trim().length > 0;
  // One project needs no headers: the shelf reads exactly as it did before.
  const grouped = shouldGroupByProject(shelves);
  const { isGroupCollapsed, toggleGroup } = useCollapsedGroups();
  const groupedShelves = useMemo(() => {
    const groupsFor = (shelf: InboxShelf): ProjectGroupRows[] =>
      groupRowsByProject(shelves[shelf], (projectId) => personalProjectIds.has(projectId));
    return {
      pinned: groupsFor("pinned"),
      nextAction: groupsFor("nextAction"),
      waiting: groupsFor("waiting"),
      snoozed: groupsFor("snoozed"),
      settled: groupsFor("settled"),
    };
  }, [shelves, personalProjectIds]);
  const { pinned, nextAction, waiting } = groupedShelves;
  const activeShelves = [
    ["pinned", "Pinned", pinned],
    ["nextAction", "Next Action", nextAction],
    ["waiting", "Waiting", waiting],
  ] as const;
  // The rows the user can see, in the order they see them, so settling walks
  // to the visible neighbour and never into a folded group.
  const visibleActiveThreads = useMemo(
    () =>
      (
        [
          ["pinned", pinned],
          ["nextAction", nextAction],
          ["waiting", showWaiting || searching ? waiting : []],
        ] as const
      ).flatMap(([shelf, groups]) =>
        groups.flatMap((group) =>
          grouped && !searching && isGroupCollapsed(groupCollapseKey(shelf, group.projectId))
            ? []
            : group.rows.map((row) => row.node.thread),
        ),
      ),
    [pinned, nextAction, waiting, showWaiting, searching, grouped, isGroupCollapsed],
  );
  const navigate = useBbNavigate();
  const onNewThread = useCommittedEvent((projectId: string) => {
    navigate.toProject(projectId);
    onNavigate();
  });
  const shelfStyle = {
    "--gtd-shelf-head-h": isCompactViewport ? "40px" : "24px",
  } as CSSProperties;
  const renderGroups = (
    shelf: InboxShelf,
    groups: readonly ProjectGroupRows[],
    renderRow: (row: VisibleInboxRow) => React.ReactNode,
  ) =>
    grouped ? (
      groups.map((group) => {
        const key = groupCollapseKey(shelf, group.projectId);
        return (
          <ProjectGroup
            key={group.projectId}
            projectId={group.projectId}
            name={projectNameById.get(group.projectId) ?? "Unknown project"}
            families={group.families}
            attention={group.attention}
            expanded={searching || !isGroupCollapsed(key)}
            onToggle={() => toggleGroup(key)}
            onNewThread={onNewThread}
            isCompactViewport={isCompactViewport}
          >
            {group.rows.map(renderRow)}
          </ProjectGroup>
        );
      })
    ) : (
      <ul className="flex flex-col gap-0.5">
        {groups.flatMap((group) => group.rows).map(renderRow)}
      </ul>
    );

  const scopeLabel =
    scope === ALL_PROJECTS ? "All projects" : (projectNameById.get(scope) ?? "All projects");

  const command = useRowCommands({
    activeThreadId,
    onNavigate,
    lifecycle,
    settledThreads,
    visibleActiveThreads,
  });

  return (
    <MachineAppearanceProvider localMachineId={settingValues?.localMachineId}>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-1 px-2 pb-0.5">
          <Select value={scope} onValueChange={setScope}>
            {/* Ghost trigger: no border, no filled track — it reads as a label
              until you hover it.

              `border-transparent` alongside `border-0`, because width and
              color are separate merge groups: `border-0` alone leaves
              `border-input` on the element, and a theme is free to key a
              recessed background off that class rather than off a drawn
              border. Evicting the color class is what actually keeps the
              track clear. */}
            <SelectTrigger
              className={cn(
                "h-6 min-w-0 flex-1 border-0 border-transparent px-1.5 py-1 text-xs font-medium text-muted-foreground shadow-none hover:bg-sidebar-accent focus:ring-0",
                isCompactViewport && "min-h-10",
              )}
              aria-label={`Project scope: ${scopeLabel}`}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_PROJECTS} className="text-xs">
                All projects
              </SelectItem>
              {projects.map((project) => (
                <SelectItem key={project.id} value={project.id} className="text-xs">
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <MachineScopePicker
            machines={machines}
            value={machineScope}
            onValueChange={setMachineScope}
            isCompactViewport={isCompactViewport}
          />
        </div>

        <div
          className={cn(
            "min-h-0 flex-1 overflow-y-auto px-1.5",
            isCompactViewport ? "pb-8" : "pb-2",
          )}
          // bb's compact footer overlays the list edge. Fade content into that
          // surface, while the matching padding lets the final row scroll clear.
          style={isCompactViewport ? MOBILE_SCROLL_FADE_STYLE : undefined}
        >
          <InboxContent
            status={status}
            ready={lifecycle.shelvesReady && settledThreads.ready}
            count={shelvedTotal}
            searchQuery={searchQuery}
          >
            {activeShelves.map(([shelf, label, groups]) =>
              groups.length > 0 ? (
                <Shelf
                  key={label}
                  label={label}
                  count={shelves[shelf].length}
                  isCompactViewport={isCompactViewport}
                  style={shelfStyle}
                  {...(shelf === "waiting"
                    ? {
                        expanded: showWaiting || searching,
                        onToggle: () => setShowWaiting((open) => !open),
                      }
                    : {})}
                >
                  {renderGroups(shelf, groups, (row) => {
                    const thread = row.node.thread;
                    return (
                      <ThreadCard
                        key={thread.id}
                        thread={thread}
                        shelf={shelf}
                        provider={providerInfoById.get(thread.providerId)}
                        showProviderIcon={showProviderIcon}
                        compactThreads={compactThreads}
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
                        branchName={resolveSidebarBranchLabel(
                          thread.environment?.branchName ?? null,
                          thread.environment?.id ?? null,
                          gitButlerLabels,
                        )}
                        isActive={thread.id === activeThreadId}
                        canPark={lifecycle.canPark(thread)}
                        isCompactViewport={isCompactViewport}
                        command={command}
                        now={now}
                      />
                    );
                  })}
                </Shelf>
              ) : null,
            )}
            {(
              [
                ["snoozed", "Snoozed", showSnoozed, setShowSnoozed, lifecycle.wakeAtFor],
                ["settled", "Settled", showSettled, setShowSettled, () => null],
              ] as const
            ).map(([shelf, label, show, setShow, wakeAtFor]) =>
              groupedShelves[shelf].length > 0 ? (
                <Shelf
                  key={label}
                  label={label}
                  count={shelves[shelf].length}
                  isCompactViewport={isCompactViewport}
                  style={shelfStyle}
                  expanded={show || searching}
                  onToggle={() => setShow((open) => !open)}
                >
                  {renderGroups(shelf, groupedShelves[shelf], (row) => {
                    const thread = row.node.thread;
                    return (
                      <SlimRow
                        key={thread.id}
                        thread={thread}
                        compactThreads={compactThreads}
                        projectName={projectNameById.get(thread.projectId) ?? null}
                        provider={providerInfoById.get(thread.providerId)}
                        branchName={resolveSidebarBranchLabel(
                          thread.environment?.branchName ?? null,
                          thread.environment?.id ?? null,
                          gitButlerLabels,
                        )}
                        isActive={thread.id === activeThreadId}
                        shelf={shelf}
                        wakeAt={wakeAtFor(thread)}
                        now={now}
                        isCompactViewport={isCompactViewport}
                        command={command}
                      />
                    );
                  })}
                </Shelf>
              ) : null,
            )}
          </InboxContent>
        </div>
      </div>
    </MachineAppearanceProvider>
  );
}

function useRowCommands({
  activeThreadId,
  onNavigate,
  lifecycle,
  settledThreads,
  visibleActiveThreads,
}: {
  activeThreadId: PluginThreadListProps["activeThreadId"];
  onNavigate: PluginThreadListProps["onNavigate"];
  lifecycle: LifecycleApi;
  settledThreads: SettledThreadsApi;
  visibleActiveThreads: readonly PluginSidebarThread[];
}) {
  const threadActions = useSidebarThreadActions();
  const navigate = useBbNavigate();
  // The palette's settle row archives through this same host action, and a
  // mounted list is the only place the action exists.
  useEffect(() => {
    publishSidebarActions(threadActions);
    return () => forgetSidebarActions(threadActions);
  }, [threadActions]);
  // bb's archive sends the viewer to the compose screen once the mutation
  // resolves. Route changes commit inside a React transition, so against a
  // local server that lands before the neighbour's route does and wins. The
  // neighbour is therefore opened twice if need be: eagerly, and again from
  // this effect once the view has left the settled thread for nothing.
  const pendingAdvanceRef = useRef<{ settledThreadId: string; nextThreadId: string } | null>(null);
  useEffect(() => {
    const pending = pendingAdvanceRef.current;
    if (pending === null || activeThreadId === pending.settledThreadId) return;
    pendingAdvanceRef.current = null;
    if (activeThreadId === null) threadActions.open(pending.nextThreadId);
  }, [activeThreadId, threadActions]);

  const settleAndAdvance = (threadId: string, sectionThreads: readonly PluginSidebarThread[]) => {
    const nextThreadId = nextThreadIdAfterSettle(sectionThreads, threadId, activeThreadId);
    if (nextThreadId !== null) {
      pendingAdvanceRef.current = { settledThreadId: threadId, nextThreadId };
      threadActions.open(nextThreadId);
      onNavigate();
    }
    threadActions.archive(threadId);
  };

  const command = useCommittedEvent((command: RowCommand) => {
    switch (command.kind) {
      case "open":
        if (command.shelf === "settled") navigate.toThread(command.threadId);
        else threadActions.open(command.threadId, { split: command.split });
        onNavigate();
        return;
      case "settle":
        settleAndAdvance(command.threadId, visibleActiveThreads);
        return;
      case "snooze":
        lifecycle.snooze(command.threadId, command.until);
        return;
      case "restore":
        if (command.shelf === "snoozed") lifecycle.unsnooze(command.threadId);
        else settledThreads.unsettle(command.threadId);
        return;
      case "pin":
        void threadActions.setPinned(command.threadId, command.pinned);
        return;
      case "request-delete":
        threadActions.requestDelete(command.threadId);
    }
  });

  return command;
}

function useInboxTree(
  threads: readonly PluginSidebarThread[],
  lifecycle: LifecycleApi,
  scope: string,
  machineScope: string | null,
  searchQuery: string,
) {
  const [collapsedThreads, setCollapsedThreads] = useState<ReadonlySet<string>>(() => new Set());
  const toggleThread = useCommittedEvent((threadId: string) => {
    setCollapsedThreads((current) => {
      const next = new Set(current);
      if (next.has(threadId)) next.delete(threadId);
      else next.add(threadId);
      return next;
    });
  });
  const tree = useMemo(
    () =>
      buildInboxTree(
        filterByProject(
          filterByMachine(threads, machineScope),
          scope === ALL_PROJECTS ? null : scope,
        ),
        (thread) => (lifecycle.shelfFor(thread) === "snoozed" ? "snoozed" : "active"),
        searchQuery,
      ),
    [lifecycle, scope, machineScope, searchQuery, threads],
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
      nextAction: rows("nextAction"),
      waiting: rows("waiting"),
      snoozed: rows("snoozed"),
      settled: rows("settled"),
    };
  }, [collapsedThreads, searchQuery, tree]);
  return { shelves, toggleThread };
}

/**
 * Folded project groups, keyed by shelf and project: folding bb-plugins in
 * Next Action leaves it open in Waiting. Session state on purpose — a fold is
 * a way to tidy the current scan, not a preference to carry across restarts.
 */
function useCollapsedGroups() {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const toggleGroup = useCommittedEvent((key: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  });
  const isGroupCollapsed = useMemo(() => (key: string) => collapsed.has(key), [collapsed]);
  return { isGroupCollapsed, toggleGroup };
}

function useMinuteClock(): number {
  // One clock for every card in a render, quantized to the minute so the
  // labels do not disagree and do not churn on unrelated re-renders.
  const [nowMinute, setNowMinute] = useState(() => Math.floor(Date.now() / 60_000));
  useEffect(() => {
    const timer = setInterval(() => setNowMinute(Math.floor(Date.now() / 60_000)), 60_000);
    return () => clearInterval(timer);
  }, []);
  return nowMinute * 60_000;
}

function useGitButlerLabels(threads: readonly PluginSidebarThread[]): ReadonlyMap<string, string> {
  const rpc = useRpc<typeof gtdSidebarRpcContract>();
  const gitButlerEnvironmentIds = useMemo(
    () =>
      [
        ...new Set(
          threads.flatMap((thread) => {
            const environment = thread.environment;
            return environment?.workspaceDisplayKind === "other" && environment.id !== null
              ? [environment.id]
              : [];
          }),
        ),
      ].sort(),
    [threads],
  );
  const gitButlerEnvironmentKey = gitButlerEnvironmentIds.join("\u0000");
  const [gitButlerLabels, setGitButlerLabels] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );

  useEffect(() => {
    if (gitButlerEnvironmentKey.length === 0) {
      setGitButlerLabels((current) => (current.size === 0 ? current : new Map()));
      return;
    }

    const environmentIds = gitButlerEnvironmentKey.split("\u0000");
    let cancelled = false;
    const refresh = async () => {
      try {
        const result = await rpc.call("listEnvironmentBranches", { environmentIds });
        if (!cancelled) {
          const next = new Map(
            result.environments.map((environment) => [
              environment.environmentId,
              environment.label,
            ]),
          );
          setGitButlerLabels((current) => (gitButlerLabelsMatch(current, next) ? current : next));
        }
      } catch {
        // Keep the last known virtual branch. The host may reconnect before
        // the next bounded refresh, and bb's own label remains the fallback.
      }
    };

    void refresh();
    const timer = setInterval(() => void refresh(), GITBUTLER_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [gitButlerEnvironmentKey, rpc]);

  return gitButlerLabels;
}

/** Wait for plugin shelf reads before deciding whether the list is empty. */
function InboxContent({
  status,
  ready,
  count,
  searchQuery,
  children,
}: {
  status: ReturnType<typeof useSidebarThreads>["status"];
  ready: boolean;
  count: number;
  searchQuery: string;
  children: React.ReactNode;
}) {
  if (status === "loading") return null;
  if (status === "error") {
    return <InboxStatus>Could not load threads.</InboxStatus>;
  }
  if (!ready) return null;
  if (count === 0) {
    return <InboxStatus>{searchQuery.trim() ? "No threads found" : "No threads yet"}</InboxStatus>;
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
 * A shelf of full cards. Passing `expanded` and `onToggle` turns the header
 * into a collapse toggle; without them the header is a plain label and the
 * rows always show.
 */
function Shelf({
  label,
  count,
  expanded,
  onToggle,
  children,
  isCompactViewport,
  style,
}: {
  label: string;
  count: number;
  expanded?: boolean;
  onToggle?: () => void;
  children: React.ReactNode;
  isCompactViewport: boolean;
  style?: CSSProperties;
}) {
  return (
    <section aria-label={label} style={style}>
      <ShelfHeader
        label={label}
        count={count}
        expanded={expanded}
        onToggle={onToggle}
        isCompactViewport={isCompactViewport}
      />
      {/* Cards need a real gap, not a hairline: their own padding is 6px, so a
          1px seam let two stacked cards read as one block. Slim rows below get
          less — a single centred line already carries its own air. */}
      {expanded === false ? null : children}
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
  expanded,
  onToggle,
  isCompactViewport,
}: {
  label: string;
  count: number;
  expanded?: boolean;
  onToggle?: () => void;
  isCompactViewport: boolean;
}) {
  const mutedClass = isCompactViewport ? "text-muted-foreground" : "text-muted-foreground/70";
  const title = (
    <span className={cn("text-2xs font-medium", mutedClass)}>
      {expanded === false ? `${label} (${count})` : label}
    </span>
  );
  const rule = <span className="h-px flex-1 bg-sidebar-border" />;

  if (expanded === undefined || onToggle === undefined) {
    return (
      <h2 className="gtd-shelf-header flex items-center gap-2 px-2.5 pb-0.5 pt-2">
        {title}
        {rule}
      </h2>
    );
  }

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      // Padded like a card, so the chevron ends on the same right edge as
      // every row's status and provider glyph. `cursor-pointer` is explicit
      // because Tailwind v4's preflight gives a button `cursor: default`,
      // and the whole header is the hit target for collapsing the shelf.
      className={cn(
        "gtd-shelf-header flex w-full cursor-pointer items-center gap-2 px-2.5 text-left",
        isCompactViewport ? "min-h-10" : "pb-0.5 pt-2",
      )}
    >
      {title}
      {rule}
      <span className={TRAILING_GLYPH_BOX_CLASS}>
        <Icon
          name="ChevronDown"
          className={cn("size-3 transition-transform", mutedClass, expanded && "rotate-180")}
        />
      </span>
    </button>
  );
}
