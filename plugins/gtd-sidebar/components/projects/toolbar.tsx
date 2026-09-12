import { useCallback, useEffect, useMemo, useState } from "react";
import {
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  experimental_useSidebarThreadPullRequest as useSidebarThreadPullRequest,
  experimental_useSidebarThreads as useSidebarThreads,
  useBbNavigate,
  useComposer,
  useComposerView,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import type { Initiative } from "@/lib/initiative-types";
import { railThreadRows } from "@/lib/initiative-ui";
import { useInitiatives } from "@/hooks/use-initiatives";
import { useInitiativeSubscriptions } from "@/hooks/use-initiative-subscriptions";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { FadingText } from "@/components/inbox/thread-details";
import { NewAgentForm } from "@/components/projects/new-agent-form";
import { SubscriptionList } from "@/components/projects/subscriptions";

/**
 * The coordinator toolbar above the native composer: Agents, PRs, Listening —
 * the three Cursor counters — each opening a compact popover tray. Renders
 * only on coordinator threads; every other composer gets the stock chrome.
 */
export function ProjectToolbar() {
  const view = useComposerView();
  const initiatives = useInitiatives();
  const { threads } = useSidebarThreads();

  const scope = view.scope;
  const initiative =
    scope.kind === "thread" ? (initiatives.byCoordinator.get(scope.threadId) ?? null) : null;
  if (initiative === null) return null;

  return <ToolbarRow initiative={initiative} threads={threads} />;
}

function ToolbarRow({
  initiative,
  threads,
}: {
  initiative: Initiative;
  threads: readonly PluginSidebarThread[];
}) {
  const navigate = useBbNavigate();
  const subscriptions = useInitiativeSubscriptions(initiative.id);
  const rows = useMemo(
    () => railThreadRows(threads, initiative.coordinatorThreadId),
    [threads, initiative.coordinatorThreadId],
  );
  const agents = useMemo(() => {
    const byId = new Map(threads.map((thread) => [thread.id, thread]));
    return rows
      .slice(1)
      .map((row) => byId.get(row.threadId))
      .filter((thread): thread is PluginSidebarThread => thread !== undefined);
  }, [rows, threads]);

  return (
    <div
      className="flex items-center gap-1 px-1 pb-1"
      data-project-toolbar={initiative.id}
      role="toolbar"
      aria-label={`${initiative.name} project`}
    >
      <TrayButton icon="Users" label="Agents" count={agents.length}>
        <AgentsTray initiative={initiative} agents={agents} />
      </TrayButton>
      <PrsTrayButton agents={agents} />
      <TrayButton icon="Rss" label="Listening" count={subscriptions.enabledCount}>
        <ListeningTray
          initiative={initiative}
          onManage={() =>
            navigate.openThreadPanel({
              actionId: "project",
              params: { tab: "subscriptions" },
            })
          }
        />
      </TrayButton>
    </div>
  );
}

function TrayButton({
  icon,
  label,
  count,
  children,
}: {
  icon: "Users" | "GitPullRequest" | "Rss";
  label: string;
  count?: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${label}${count !== undefined ? ` ${count}` : ""}`}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Icon name={icon} className="size-3.5" aria-hidden />
          {label}
          {count !== undefined && count > 0 ? (
            <span className="tabular-nums text-muted-foreground/70">{count}</span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-80 p-2" aria-label={`${label} tray`}>
        {children}
      </PopoverContent>
    </Popover>
  );
}

function AgentsTray({
  initiative,
  agents,
}: {
  initiative: Initiative;
  agents: readonly PluginSidebarThread[];
}) {
  const threadActions = useSidebarThreadActions();
  const composer = useComposer();
  const [newAgentOpen, setNewAgentOpen] = useState(false);

  const reference = (thread: PluginSidebarThread) => {
    const title = thread.title ?? thread.titleFallback ?? "the agent";
    // No thread-mention provider exists in the SDK contract yet — a quote
    // carrying the real thread id is the unambiguous, durable reference the
    // coordinator can act on.
    composer.addQuote(`Agent: ${title} — thread ${thread.id}`);
  };

  return (
    <div className="flex flex-col" data-agents-tray="">
      {agents.length === 0 ? (
        <p className="px-2 py-3 text-xs text-muted-foreground">
          No agents yet. Start one below, or ask the coordinator to delegate.
        </p>
      ) : (
        <ul className="flex max-h-64 flex-col gap-px overflow-y-auto">
          {agents.map((thread) => {
            const title = thread.title ?? thread.titleFallback ?? "Untitled agent";
            return (
              <li
                key={thread.id}
                className="flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-accent/50"
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
                  onClick={() => reference(thread)}
                  className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <Icon name="ExternalLink" className="size-3.5" aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <Popover open={newAgentOpen} onOpenChange={setNewAgentOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="mt-1 flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Icon name="Plus" className="size-3.5" aria-hidden />
            New agent
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          className="w-72 p-3"
          aria-label={`New agent for ${initiative.name}`}
        >
          <NewAgentForm initiative={initiative} onLaunched={() => setNewAgentOpen(false)} />
        </PopoverContent>
      </Popover>
    </div>
  );
}

/**
 * The PRs button carries a live count even while its tray is closed: one
 * invisible reporter per agent resolves its thread's PR state and reports up.
 */
function PrsTrayButton({ agents }: { agents: readonly PluginSidebarThread[] }) {
  const [states, setStates] = useState<ReadonlyMap<string, boolean>>(new Map());
  const report = useCallback((threadId: string, hasPr: boolean) => {
    setStates((previous) => {
      if (previous.get(threadId) === hasPr) return previous;
      return new Map(previous).set(threadId, hasPr);
    });
  }, []);
  const count = [...states.values()].filter(Boolean).length;
  return (
    <>
      <TrayButton icon="GitPullRequest" label="PRs" count={count}>
        <PrsTray agents={agents} />
      </TrayButton>
      {agents.map((thread) => (
        <PrReporter
          key={thread.id}
          threadId={thread.id}
          onChange={(hasPr) => report(thread.id, hasPr)}
        />
      ))}
    </>
  );
}

function PrReporter({
  threadId,
  onChange,
}: {
  threadId: string;
  onChange: (hasPr: boolean) => void;
}) {
  const { pullRequest } = useSidebarThreadPullRequest(threadId);
  // The badge counts actionable PRs only: open and draft still need eyes;
  // merged and closed are history the tray can show without inflating it.
  const hasPr =
    pullRequest !== null && (pullRequest.state === "open" || pullRequest.state === "draft");
  useEffect(() => {
    onChange(hasPr);
  }, [onChange, hasPr]);
  return null;
}

function PrsTray({ agents }: { agents: readonly PluginSidebarThread[] }) {
  return (
    <div className="flex flex-col" data-prs-tray="">
      {agents.length === 0 ? (
        <p className="px-2 py-3 text-xs text-muted-foreground">No agents — no pull requests yet.</p>
      ) : (
        <ul className="flex max-h-64 flex-col gap-px overflow-y-auto">
          {agents.map((thread) => (
            <AgentPrRow key={thread.id} thread={thread} />
          ))}
        </ul>
      )}
    </div>
  );
}

function AgentPrRow({ thread }: { thread: PluginSidebarThread }) {
  const navigate = useBbNavigate();
  const { pullRequest, isLoading } = useSidebarThreadPullRequest(thread.id);
  const title = thread.title ?? thread.titleFallback ?? "Untitled agent";
  if (isLoading) {
    return (
      <li className="flex items-center gap-2 px-1.5 py-1 text-xs text-muted-foreground">
        <Icon name="Loading" className="size-3 animate-spin" aria-hidden />
        <span className="truncate">{title}</span>
      </li>
    );
  }
  if (pullRequest === null) {
    return (
      <li className="flex items-center gap-2 px-1.5 py-1 text-xs text-muted-foreground">
        <span className="size-1.5 rounded-full bg-muted-foreground/30" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <span className="text-2xs">No PR</span>
      </li>
    );
  }
  return (
    <li>
      <button
        type="button"
        onClick={() => navigate.openUrl(pullRequest.url)}
        className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs hover:bg-accent/50"
        title={pullRequest.title}
      >
        <Icon
          name="GitPullRequest"
          className={cn(
            "size-3.5 shrink-0",
            pullRequest.state === "open" && "text-primary",
            pullRequest.state === "merged" && "text-muted-foreground",
          )}
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate">
          #{pullRequest.number} {pullRequest.title}
        </span>
        <span className="shrink-0 text-2xs capitalize text-muted-foreground">
          {pullRequest.attention.replaceAll("_", " ")}
        </span>
      </button>
    </li>
  );
}

function ListeningTray({ initiative, onManage }: { initiative: Initiative; onManage: () => void }) {
  return (
    <div className="flex flex-col" data-listening-tray="">
      <SubscriptionList initiative={initiative} compact />
      <button
        type="button"
        onClick={onManage}
        className="mt-1 flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <Icon name="Settings" className="size-3.5" aria-hidden />
        Manage subscriptions
      </button>
    </div>
  );
}
