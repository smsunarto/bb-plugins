import { useMemo, useState, type PointerEvent } from "react";
import {
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  experimental_useSidebarThreadSplit as useSidebarThreadSplit,
  useBbNavigate,
  useRpc,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import type { Initiative } from "@/lib/initiative-types";
import type { initiativeRpcContract } from "@/lib/initiative-rpc";
import { railThreadRows } from "@/lib/initiative-ui";
import { useInitiatives } from "@/hooks/use-initiatives";
import { useCommittedEvent } from "@/hooks/use-committed-event";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { FadingText } from "@/components/inbox/thread-details";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { InitiativeIcon } from "@/components/projects/icons";
import { ArchiveProjectDialog } from "@/components/projects/archive-project-dialog";
import { NewAgentForm } from "@/components/projects/new-agent-form";

const SECTION_LABEL = "Projects";

/**
 * The Projects rail: one section above the inbox shelves. Each project row is
 * the coordinator thread's only sidebar anchor; expanding it nests agent
 * descendants recursively (railThreadRows guarantees every project thread
 * appears exactly once). The inbox filters these same threads out, so the
 * shortcut contract sees each thread at exactly one row.
 */
export function ProjectsRail({
  activeThreadId,
  isCompactViewport,
  threads,
  onNavigate,
}: {
  activeThreadId: string | null;
  isCompactViewport: boolean;
  /** The unfiltered sidebar feed — rail rows come straight from it. */
  threads: readonly PluginSidebarThread[];
  onNavigate: () => void;
}) {
  const initiatives = useInitiatives();
  const navigate = useBbNavigate();
  // Explicit user choices only. A project containing the active thread
  // auto-expands until the user toggles it — after that, their choice wins
  // (including "stay collapsed"), so the chevron always does what it says.
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(new Map());

  const setExpanded = (initiativeId: string, expanded: boolean) => {
    setOverrides((previous) => new Map(previous).set(initiativeId, expanded));
  };

  return (
    <section aria-label={SECTION_LABEL} data-projects-rail="" className="mb-1 px-1.5">
      <div className="flex items-center gap-1 px-1.5 pb-0.5 pt-1">
        <span className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
          {SECTION_LABEL}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          aria-label="New project"
          title="New project"
          onClick={() => {
            navigate.toPluginPanel("projects", { subPath: "new" });
            onNavigate();
          }}
          className="flex size-5 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Icon name="Plus" className="size-3.5" aria-hidden />
        </button>
      </div>
      {initiatives.status === "error" ? (
        <div className="flex items-center gap-2 px-1.5 py-1 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">Couldn’t load projects</span>
          <Button variant="ghost" size="xs" onClick={initiatives.retry}>
            Retry
          </Button>
        </div>
      ) : null}
      <ul className="flex flex-col gap-px">
        {initiatives.active.map((initiative) => (
          <ProjectRow
            key={initiative.id}
            initiative={initiative}
            threads={threads}
            expanded={
              overrides.get(initiative.id) ??
              railThreadRows(threads, initiative.coordinatorThreadId).some(
                (row) => row.threadId === activeThreadId,
              )
            }
            onToggle={(next) => setExpanded(initiative.id, next)}
            activeThreadId={activeThreadId}
            isCompactViewport={isCompactViewport}
            onNavigate={onNavigate}
          />
        ))}
      </ul>
      <button
        type="button"
        onClick={() => {
          navigate.toPluginPanel("projects", { subPath: "new" });
          onNavigate();
        }}
        className="mt-0.5 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
      >
        <Icon name="Plus" className="size-3.5" aria-hidden />
        New project
      </button>
    </section>
  );
}

function ProjectRow({
  initiative,
  threads,
  expanded,
  onToggle,
  activeThreadId,
  isCompactViewport,
  onNavigate,
}: {
  initiative: Initiative;
  threads: readonly PluginSidebarThread[];
  expanded: boolean;
  onToggle: (next: boolean) => void;
  activeThreadId: string | null;
  isCompactViewport: boolean;
  onNavigate: () => void;
}) {
  const rpc = useRpc<typeof initiativeRpcContract>();
  const threadActions = useSidebarThreadActions();
  const { splitProps } = useSidebarThreadSplit(initiative.coordinatorThreadId);
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [newAgentOpen, setNewAgentOpen] = useState(false);

  const rows = useMemo(
    () => railThreadRows(threads, initiative.coordinatorThreadId),
    [threads, initiative.coordinatorThreadId],
  );
  const descendantCount = rows.length - 1;
  const threadById = useMemo(
    () => new Map(threads.map((thread) => [thread.id, thread])),
    [threads],
  );
  const isActive = activeThreadId === initiative.coordinatorThreadId;

  const openCoordinator = (split: boolean) => {
    threadActions.open(initiative.coordinatorThreadId, { split });
    onNavigate();
  };

  const rename = (name: string) => {
    const trimmed = name.trim();
    if (trimmed === "" || trimmed === initiative.name) {
      setRenaming(false);
      setRenameError(null);
      return;
    }
    setRenameError(null);
    rpc
      .call("updateInitiative", { initiativeId: initiative.id, name: trimmed })
      .then(() => {
        setRenaming(false);
        setRenameError(null);
      })
      // Failure keeps the editor open with the reason — Enter retries.
      .catch((renameFailure: unknown) =>
        setRenameError(renameFailure instanceof Error ? renameFailure.message : "Rename failed"),
      );
  };

  const row = (
    <li className="list-none">
      <div
        className={cn(
          "group/project relative flex items-center gap-1 rounded-lg pr-1",
          isActive && "bg-accent/70",
        )}
        data-project-row={initiative.id}
      >
        <button
          type="button"
          aria-label={expanded ? `Collapse ${initiative.name}` : `Expand ${initiative.name}`}
          aria-expanded={expanded}
          onClick={() => onToggle(!expanded)}
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground",
            descendantCount === 0 && "invisible",
          )}
        >
          <Icon name={expanded ? "ChevronDown" : "ChevronRight"} className="size-3.5" aria-hidden />
        </button>
        {/* oxlint-disable-next-line jsx-a11y/anchor-is-valid -- must stay an
            anchor: the shortcut-target contract and modifier-click
            split-open both depend on it. */}
        <a
          onPointerDown={
            splitProps.onPointerDown
              ? (event: PointerEvent<HTMLElement>) => {
                  if (event.button !== 0) return;
                  splitProps.onPointerDown?.(event);
                }
              : undefined
          }
          data-sidebar-thread-shortcut-target=""
          data-sidebar-thread-id={initiative.coordinatorThreadId}
          href="#"
          aria-label={initiative.name}
          onClick={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            openCoordinator(event.metaKey || event.ctrlKey);
          }}
          className="absolute inset-0 left-6 cursor-pointer rounded-lg"
        />
        {/* Children below are pointer-events-none so the overlay anchor gets
            every click in its region — same trick the slim row uses. */}
        <InitiativeIcon
          icon={initiative.icon}
          className="pointer-events-none relative size-3.5 text-muted-foreground"
        />
        {renaming ? (
          <input
            defaultValue={initiative.name}
            aria-label="Project name"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Enter") rename(event.currentTarget.value);
              if (event.key === "Escape") {
                setRenaming(false);
                setRenameError(null);
              }
            }}
            onBlur={(event) => rename(event.currentTarget.value)}
            className="relative min-w-0 flex-1 rounded bg-background px-1 py-0.5 text-xs outline-none ring-1 ring-ring"
          />
        ) : (
          <span className="pointer-events-none relative min-w-0 flex-1 truncate py-1.5 text-xs font-medium">
            {isCompactViewport ? initiative.name : <FadingText text={initiative.name} />}
          </span>
        )}
        {renameError !== null ? (
          <span
            role="alert"
            className="pointer-events-none relative truncate pr-1 text-2xs text-destructive"
          >
            {renameError}
          </span>
        ) : null}
        {descendantCount > 0 ? (
          <span
            aria-label={`${descendantCount} agents`}
            className="pointer-events-none relative rounded-full bg-muted px-1.5 text-2xs tabular-nums text-muted-foreground"
          >
            {descendantCount}
          </span>
        ) : null}
      </div>
      {expanded ? (
        <ul className="flex flex-col gap-px">
          {rows.slice(1).map(({ threadId, depth }) => {
            const thread = threadById.get(threadId);
            if (thread === undefined) return null;
            return (
              <AgentRow
                key={threadId}
                thread={thread}
                depth={depth}
                isActive={threadId === activeThreadId}
                onNavigate={onNavigate}
              />
            );
          })}
          <li className="list-none">
            <Popover open={newAgentOpen} onOpenChange={setNewAgentOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-lg py-1 pl-7 pr-2 text-xs text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
                >
                  <Icon name="Plus" className="size-3" aria-hidden />
                  New agent
                </button>
              </PopoverTrigger>
              <PopoverContent
                side="right"
                align="start"
                className="w-72 p-3"
                aria-label={`New agent for ${initiative.name}`}
              >
                <NewAgentForm initiative={initiative} onLaunched={() => setNewAgentOpen(false)} />
              </PopoverContent>
            </Popover>
          </li>
        </ul>
      ) : null}
      <ArchiveProjectDialog
        initiative={initiative}
        agentCount={descendantCount}
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
      />
    </li>
  );

  if (isCompactViewport) return row;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent aria-label={`${initiative.name} actions`}>
        <ContextMenuItem onSelect={() => openCoordinator(false)}>
          <Icon name="ExternalLink" className="size-4 shrink-0" />
          Open project
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => setRenaming(true)}>
          <Icon name="Pencil" className="size-4 shrink-0" />
          Rename project
        </ContextMenuItem>
        <ContextMenuItem destructive onSelect={() => setArchiveOpen(true)}>
          <Icon name="Trash" className="size-4 shrink-0" />
          Archive project…
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function AgentRow({
  thread,
  depth,
  isActive,
  onNavigate,
}: {
  thread: PluginSidebarThread;
  depth: number;
  isActive: boolean;
  onNavigate: () => void;
}) {
  const threadActions = useSidebarThreadActions();
  const { splitProps } = useSidebarThreadSplit(thread.id);
  const title = thread.title ?? thread.titleFallback ?? "Untitled agent";
  const onSplitPointerDown = useCommittedEvent((event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    splitProps.onPointerDown?.(event);
  });

  return (
    <li className="list-none">
      <div
        className={cn(
          "relative flex items-center gap-2 rounded-lg py-1 pr-2",
          isActive && "bg-accent/70",
        )}
        style={{ paddingLeft: `${28 + (depth - 1) * 14}px` }}
        data-project-agent-row={thread.id}
      >
        {/* oxlint-disable-next-line jsx-a11y/anchor-is-valid -- same anchor
            contract as every sidebar row. */}
        <a
          onPointerDown={splitProps.onPointerDown ? onSplitPointerDown : undefined}
          data-sidebar-thread-shortcut-target=""
          data-sidebar-thread-id={thread.id}
          href="#"
          aria-label={title}
          onClick={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            threadActions.open(thread.id, {
              split: event.metaKey || event.ctrlKey,
            });
            onNavigate();
          }}
          className="absolute inset-0 cursor-pointer rounded-lg"
        />
        <span
          aria-hidden
          className={cn(
            "pointer-events-none size-1.5 shrink-0 rounded-full",
            thread.indicator === "none" ? "bg-muted-foreground/40" : "bg-primary",
          )}
        />
        <span className="pointer-events-none min-w-0 flex-1 truncate text-xs text-muted-foreground">
          <FadingText text={title} />
        </span>
        {thread.isUnread ? (
          <span
            aria-label="Unread"
            className="pointer-events-none size-1.5 rounded-full bg-primary"
          />
        ) : null}
      </div>
    </li>
  );
}
