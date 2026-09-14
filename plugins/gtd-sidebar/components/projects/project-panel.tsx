import { useProjectFeatures } from "@/hooks/use-project-features";
import { useEffect, useMemo, useState } from "react";
import {
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  experimental_useSidebarThreads as useSidebarThreads,
  useComposer,
  useRpc,
  type PluginSidebarThread,
  type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import type { Initiative } from "@/lib/initiative-types";
import type { initiativeRpcContract } from "@/lib/initiative-rpc";
import {
  initiativeForThread,
  projectDescendantCount,
  railThreadRows,
  workspaceSummary,
} from "@/lib/initiative-ui";
import { useInitiatives } from "@/hooks/use-initiatives";
import { useInitiativeSubscriptions } from "@/hooks/use-initiative-subscriptions";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { FadingText } from "@/components/inbox/thread-details";
import { InitiativeIcon, InitiativeIconPicker } from "@/components/projects/icons";
import { ArchiveProjectDialog } from "@/components/projects/archive-project-dialog";
import { NewAgentForm } from "@/components/projects/new-agent-form";
import {
  SharedDirectoryPreview,
  useSharedDirectoryPreview,
} from "@/components/projects/shared-directory";
import { ContextDocs } from "@/components/projects/context-docs";
import { SubscriptionList } from "@/components/projects/subscriptions";

type PanelTab = "overview" | "agents" | "context" | "subscriptions";
const TABS: readonly { id: PanelTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "agents", label: "Agents" },
  { id: "context", label: "Context" },
  { id: "subscriptions", label: "Subscriptions" },
];

/**
 * The right-side Project panel (flush layout). Resolves the viewed thread's
 * initiative through native ancestry — an agent's panel shows its project —
 * and hosts the four Cursor surfaces: Overview, Agents, Context, Subscriptions.
 */
export function ProjectPanel({ threadId, params }: PluginThreadPanelProps) {
  const { subscriptions: subscriptionsEnabled } = useProjectFeatures();
  const initiatives = useInitiatives();
  const { threads } = useSidebarThreads();
  const paramsTab = (params as { tab?: PanelTab } | undefined)?.tab;
  const [tab, setTab] = useState<PanelTab>(
    TABS.some((t) => t.id === paramsTab) ? (paramsTab as PanelTab) : "overview",
  );
  // The panel stays mounted across openThreadPanel calls — a new params.tab
  // (e.g. Listening tray → Manage) must switch the visible tab.
  useEffect(() => {
    if (TABS.some((t) => t.id === paramsTab)) setTab(paramsTab as PanelTab);
  }, [paramsTab]);

  const visibleTab = tab === "subscriptions" && !subscriptionsEnabled ? "overview" : tab;
  const initiative = initiativeForThread(threads, threadId, initiatives.byCoordinator);
  if (initiative === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <Icon name="Folder" className="size-6 text-muted-foreground" aria-hidden />
        <p className="text-xs text-muted-foreground">This thread isn’t part of a project.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col" data-project-panel={initiative.id}>
      <div
        role="tablist"
        aria-label="Project sections"
        className="flex gap-0.5 border-b border-border px-2 pt-1.5"
      >
        {TABS.filter((t) => t.id !== "subscriptions" || subscriptionsEnabled).map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={visibleTab === t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "rounded-t-md px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground",
              visibleTab === t.id && "bg-accent/60 font-medium text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
        {visibleTab === "overview" ? (
          <OverviewTab initiative={initiative} threads={threads} />
        ) : visibleTab === "agents" ? (
          <AgentsTab initiative={initiative} threads={threads} />
        ) : visibleTab === "context" ? (
          <ContextDocs initiative={initiative} />
        ) : (
          <SubscriptionList initiative={initiative} />
        )}
      </div>
    </div>
  );
}

function OverviewTab({
  initiative,
  threads,
}: {
  initiative: Initiative;
  threads: readonly PluginSidebarThread[];
}) {
  const rpc = useRpc<typeof initiativeRpcContract>();
  const { projects } = useSidebarThreads();
  const { subscriptions: subscriptionsEnabled } = useProjectFeatures();
  const subscriptions = useInitiativeSubscriptions(initiative.id);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const projectNameById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );
  const agentCount = projectDescendantCount(threads, initiative.coordinatorThreadId);

  const update = (patch: { name?: string; icon?: string; description?: string }) => {
    setError(null);
    rpc
      .call("updateInitiative", { initiativeId: initiative.id, ...patch })
      .catch((updateError: unknown) =>
        setError(updateError instanceof Error ? updateError.message : "Save failed"),
      );
  };

  return (
    <div className="flex flex-col gap-3" data-project-overview="">
      <div className="flex items-center gap-2">
        <InitiativeIcon icon={initiative.icon} className="size-4" />
        <input
          key={initiative.updatedAt}
          defaultValue={initiative.name}
          aria-label="Project name"
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          onBlur={(event) => {
            const name = event.currentTarget.value.trim();
            if (name !== "" && name !== initiative.name) update({ name });
          }}
          className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-sm font-semibold outline-none hover:border-border focus:border-ring"
        />
      </div>
      <InitiativeIconPicker value={initiative.icon} onChange={(icon) => update({ icon })} />
      <textarea
        key={`desc-${initiative.updatedAt}`}
        defaultValue={initiative.description}
        aria-label="Project description"
        rows={2}
        placeholder="What is this project about?"
        onBlur={(event) => {
          const description = event.currentTarget.value.trim();
          if (description !== initiative.description) update({ description });
        }}
        className="resize-none rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none placeholder:text-muted-foreground/60 focus:border-ring"
      />
      <dl className="flex flex-col gap-1.5 text-xs">
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Repositories</dt>
          <dd className="truncate text-right">{workspaceSummary(initiative, projectNameById)}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Environment</dt>
          <dd className="text-right">
            {initiative.workspace.mode === "shared-directory"
              ? "Shared directory"
              : "Separate environments"}
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Agents</dt>
          <dd className="tabular-nums">{agentCount}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Listening</dt>
          <dd className="tabular-nums">
            {subscriptionsEnabled ? subscriptions.enabledCount : "Disabled in settings"}
          </dd>
        </div>
      </dl>
      {initiative.workspace.mode === "shared-directory" ? (
        <SharedDirectoryOverview initiative={initiative} />
      ) : null}
      {error !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="mt-auto flex justify-end pt-2">
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive-text"
          onClick={() => setArchiveOpen(true)}
        >
          <Icon name="Trash" className="size-3.5" aria-hidden />
          Archive project…
        </Button>
      </div>
      <ArchiveProjectDialog
        initiative={initiative}
        agentCount={agentCount}
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
      />
    </div>
  );
}

function SharedDirectoryOverview({ initiative }: { initiative: Initiative }) {
  const workspace = initiative.workspace.mode === "shared-directory" ? initiative.workspace : null;
  const preview = useSharedDirectoryPreview({
    workspaceProjectIds: initiative.workspaceProjectIds,
    enabled: workspace !== null,
    initialDirectory: workspace,
  });

  return (
    <SharedDirectoryPreview controller={preview} editable={false} fallbackDirectory={workspace} />
  );
}

function AgentsTab({
  initiative,
  threads,
}: {
  initiative: Initiative;
  threads: readonly PluginSidebarThread[];
}) {
  const threadActions = useSidebarThreadActions();
  const composer = useComposer();
  const [spawnOpen, setSpawnOpen] = useState(false);
  const rows = useMemo(
    () => railThreadRows(threads, initiative.coordinatorThreadId).slice(1),
    [threads, initiative.coordinatorThreadId],
  );
  const threadById = useMemo(
    () => new Map(threads.map((thread) => [thread.id, thread])),
    [threads],
  );

  return (
    <div className="flex flex-col gap-2" data-project-agents="">
      {rows.length === 0 ? (
        <p className="py-2 text-xs text-muted-foreground">
          No agents yet. The coordinator spawns them as it delegates — or start one directly.
        </p>
      ) : (
        <ul className="flex flex-col gap-px">
          {rows.map(({ threadId, depth }) => {
            const thread = threadById.get(threadId);
            if (thread === undefined) return null;
            const title = thread.title ?? thread.titleFallback ?? "Untitled agent";
            return (
              <li
                key={threadId}
                className="flex items-center gap-1.5 rounded-md py-1 pr-1 hover:bg-accent/40"
                style={{ paddingLeft: `${(depth - 1) * 14 + 4}px` }}
              >
                <span
                  aria-hidden
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    thread.indicator === "none" ? "bg-muted-foreground/40" : "bg-primary",
                  )}
                />
                <button
                  type="button"
                  onClick={() => threadActions.open(thread.id)}
                  className="min-w-0 flex-1 truncate text-left text-xs"
                  title={`Open ${title}`}
                >
                  <FadingText text={title} />
                </button>
                <button
                  type="button"
                  aria-label={`Reference ${title} in chat`}
                  title="Reference in chat"
                  onClick={() => composer.addQuote(`Agent: ${title} — thread ${thread.id}`)}
                  className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <Icon name="ExternalLink" className="size-3.5" aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {spawnOpen ? (
        <div className="rounded-lg border border-border p-3">
          <NewAgentForm initiative={initiative} onLaunched={() => setSpawnOpen(false)} />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setSpawnOpen(true)}
          className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Icon name="Plus" className="size-3.5" aria-hidden />
          New agent
        </button>
      )}
    </div>
  );
}
