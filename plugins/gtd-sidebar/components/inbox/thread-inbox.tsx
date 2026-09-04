import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  experimental_useSidebarThreads as useSidebarThreads,
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
import type { ProviderGlyphInfo } from "@/components/inbox/provider-glyph";
import { SlimRow } from "@/components/inbox/slim-row";
import type { gtdSidebarRpcContract } from "@/server";
import { useLifecycle } from "@/hooks/use-lifecycle";
import { useSettledThreads } from "@/hooks/use-settled-threads";
import { forgetSidebarActions, publishSidebarActions } from "@/lib/sidebar-actions-bridge";
import { TRAILING_GLYPH_BOX_CLASS } from "@/components/inbox/status-slot";
import {
  filterByProject,
  hideChildrenOfVisibleParents,
  nextThreadIdAfterSettle,
  partitionActiveSections,
  partitionPinned,
  searchThreadsByTitle,
  sortByLatestAttentionDescending,
} from "@/lib/inbox";
import { mergeSettledThreads } from "@/lib/settled-threads";
import { readWarmStartProviders, writeWarmStartProviders } from "@/lib/warm-start";
import { resolveSidebarBranchLabel } from "@/lib/gitbutler";

const ALL_PROJECTS = "__all__";
const EMPTY_STATE_CLASS = "px-2 py-6 text-center text-xs text-muted-foreground";
const GITBUTLER_REFRESH_MS = 30_000;
const MOBILE_SCROLL_FADE_STYLE: CSSProperties = {
  maskImage: "linear-gradient(to bottom, black 0, black calc(100% - 2rem), transparent 100%)",
  WebkitMaskImage: "linear-gradient(to bottom, black 0, black calc(100% - 2rem), transparent 100%)",
};

/**
 * The sidebar's scrolling list: cards grouped by who can act next.
 *
 * The host owns the New-thread button and the search field above it, so this
 * ships neither. It filters by the `searchQuery` prop and keeps only the one
 * control the host has no equivalent for: the project scope picker.
 */
export function ThreadInbox({
  activeThreadId,
  isCompactViewport,
  onNavigate,
  searchQuery,
}: PluginThreadListProps) {
  const { status, threads: hostThreads, projects } = useSidebarThreads();
  const threadActions = useSidebarThreadActions();
  // The palette's settle row archives through this same host action, and a
  // mounted list is the only place the action exists.
  useEffect(() => {
    publishSidebarActions(threadActions);
    return () => forgetSidebarActions(threadActions);
  }, [threadActions]);
  const rpc = useRpc<typeof gtdSidebarRpcContract>();
  // One clock for every card in a render, quantized to the minute so the
  // labels do not disagree and do not churn on unrelated re-renders.
  const [nowMinute, setNowMinute] = useState(() => Math.floor(Date.now() / 60_000));
  useEffect(() => {
    const timer = setInterval(() => setNowMinute(Math.floor(Date.now() / 60_000)), 60_000);
    return () => clearInterval(timer);
  }, []);
  const now = nowMinute * 60_000;
  const lifecycle = useLifecycle();
  // bb's view never carries an archived thread, so the Settled shelf's rows
  // come from a second read and are merged in before anything partitions.
  const settledThreads = useSettledThreads(now);
  const threads = useMemo(
    () => mergeSettledThreads(hostThreads, settledThreads.threads),
    [hostThreads, settledThreads.threads],
  );
  // Seeded from the same cache the shelves use, and for the same reason: a
  // remount would otherwise draw every glyph from a fallback and swap it a
  // round trip later. Nothing gates on it — a fallback glyph is a different
  // pixel, not a different layout.
  const [providerInfoById, setProviderInfoById] = useState<ReadonlyMap<string, ProviderGlyphInfo>>(
    () => new Map((readWarmStartProviders() ?? []).map((provider) => [provider.id, provider])),
  );
  const [scope, setScope] = useState<string>(ALL_PROJECTS);
  // Read once here rather than per card, and compared against `false` rather
  // than coerced: `values` is undefined while the settings load, and the
  // setting is on by default, so anything that is not an explicit "off" draws
  // the glyph. That way the common case never flashes it on and off.
  const { values: settingValues } = useSettings();
  const showProviderIcon = settingValues?.showProviderIcon !== false;

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
      setGitButlerLabels(new Map());
      return;
    }

    const environmentIds = gitButlerEnvironmentKey.split("\u0000");
    let cancelled = false;
    const refresh = async () => {
      try {
        const result = await rpc.call("listEnvironmentBranches", { environmentIds });
        if (!cancelled) {
          setGitButlerLabels(
            new Map(
              result.environments.map((environment) => [
                environment.environmentId,
                environment.label,
              ]),
            ),
          );
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

  useEffect(() => {
    let cancelled = false;
    const loadProviderInfo = async () => {
      try {
        const result = await rpc.call("listProviders", {});
        if (!cancelled) {
          setProviderInfoById(new Map(result.providers.map((provider) => [provider.id, provider])));
          writeWarmStartProviders(result.providers);
        }
      } catch {
        // Provider metadata only improves the glyph. Keep the built-in and
        // neutral fallbacks if the host cannot supply it.
      }
    };
    void loadProviderInfo();
    return () => {
      cancelled = true;
    };
  }, [rpc]);
  const [showSnoozed, setShowSnoozed] = useState(false);
  const [showSettled, setShowSettled] = useState(false);

  const projectNameById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );

  const { pinned, nextAction, waiting, snoozed, settled } = useMemo(() => {
    const scoped = filterByProject(threads, scope === ALL_PROJECTS ? null : scope);
    // Children live in their parent's header chip instead of the flat list;
    // an orphan whose parent is not on screen stays here.
    const matched = searchThreadsByTitle(hideChildrenOfVisibleParents(scoped), searchQuery);
    const active: typeof matched = [];
    const onSnoozeShelf: typeof matched = [];
    const onSettledShelf: typeof matched = [];
    for (const thread of matched) {
      // Archived outranks a snooze row the thread may still hold: the archive
      // is bb's fact, and the row is only what the plugin last wrote.
      if (thread.isArchived) onSettledShelf.push(thread);
      else if (lifecycle.shelfFor(thread) === "snoozed") onSnoozeShelf.push(thread);
      else active.push(thread);
    }
    const split = partitionPinned(active);
    const activeSections = partitionActiveSections(split.inbox);
    return {
      pinned: sortByLatestAttentionDescending(split.pinned),
      ...activeSections,
      snoozed: sortByLatestAttentionDescending(onSnoozeShelf),
      // Already newest-archive-first from the hook; the merge kept that order.
      settled: onSettledShelf,
    };
  }, [lifecycle, scope, searchQuery, threads]);

  const shelvedTotal =
    pinned.length + nextAction.length + waiting.length + snoozed.length + settled.length;

  const scopeLabel =
    scope === ALL_PROJECTS ? "All projects" : (projectNameById.get(scope) ?? "All projects");

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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The one control the host has no equivalent for. Everything else in
          the chrome above — New thread, search — is bb's and stays bb's. */}
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
      </div>

      <div
        className={cn("min-h-0 flex-1 overflow-y-auto px-1.5", isCompactViewport ? "pb-8" : "pb-2")}
        // bb's compact footer overlays the list edge. Fade content into that
        // surface, while the matching padding lets the final row scroll clear.
        style={isCompactViewport ? MOBILE_SCROLL_FADE_STYLE : undefined}
      >
        {/* Five outcomes, and the order carries the argument. The unready one
            renders nothing rather than "No threads yet" — bb's threads are
            already here, so what is still missing is this plugin's own rows,
            and a false empty state is worse than a blank moment. It comes
            after the error branch so a failed thread query still says so, and
            it is reached whenever nothing seeded the shelves: a first-ever
            run, a cleared origin, or any browser with web storage switched
            off or partitioned, where the seed misses on every page load.
            `shelvesReady`'s own deadline is behind all of them. */}
        {status === "loading" ? null : status === "error" ? (
          // `output` is for calculation results; a polite live region for a
          // status message is exactly what `role="status"` is for.
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
          <p role="status" className={EMPTY_STATE_CLASS}>
            Could not load threads.
          </p>
        ) : !lifecycle.shelvesReady || !settledThreads.ready ? null : shelvedTotal === 0 ? (
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
          <p role="status" className={EMPTY_STATE_CLASS}>
            {searchQuery.trim() ? "No threads found" : "No threads yet"}
          </p>
        ) : (
          <>
            {pinned.length > 0 ? (
              <Shelf label="Pinned" isCompactViewport={isCompactViewport}>
                {pinned.map((thread) => (
                  <ThreadCard
                    key={thread.id}
                    thread={thread}
                    provider={providerInfoById.get(thread.providerId)}
                    showProviderIcon={showProviderIcon}
                    projectName={projectNameById.get(thread.projectId) ?? null}
                    branchName={resolveSidebarBranchLabel(
                      thread.environment?.branchName ?? null,
                      thread.environment?.id ?? null,
                      gitButlerLabels,
                    )}
                    isActive={thread.id === activeThreadId}
                    canPark={lifecycle.canPark(thread)}
                    isCompactViewport={isCompactViewport}
                    onNavigate={onNavigate}
                    onSettle={() => settleAndAdvance(thread.id, pinned)}
                    onSnooze={(until) => lifecycle.snooze(thread.id, until)}
                    now={now}
                  />
                ))}
              </Shelf>
            ) : null}
            {nextAction.length > 0 ? (
              <Shelf label="Next Action" isCompactViewport={isCompactViewport}>
                {nextAction.map((thread) => (
                  <ThreadCard
                    key={thread.id}
                    thread={thread}
                    provider={providerInfoById.get(thread.providerId)}
                    showProviderIcon={showProviderIcon}
                    projectName={projectNameById.get(thread.projectId) ?? null}
                    branchName={resolveSidebarBranchLabel(
                      thread.environment?.branchName ?? null,
                      thread.environment?.id ?? null,
                      gitButlerLabels,
                    )}
                    isActive={thread.id === activeThreadId}
                    canPark={lifecycle.canPark(thread)}
                    isCompactViewport={isCompactViewport}
                    onNavigate={onNavigate}
                    onSettle={() => settleAndAdvance(thread.id, nextAction)}
                    onSnooze={(until) => lifecycle.snooze(thread.id, until)}
                    now={now}
                  />
                ))}
              </Shelf>
            ) : null}
            {waiting.length > 0 ? (
              <Shelf label="Waiting" isCompactViewport={isCompactViewport}>
                {waiting.map((thread) => (
                  <ThreadCard
                    key={thread.id}
                    thread={thread}
                    provider={providerInfoById.get(thread.providerId)}
                    showProviderIcon={showProviderIcon}
                    projectName={projectNameById.get(thread.projectId) ?? null}
                    branchName={resolveSidebarBranchLabel(
                      thread.environment?.branchName ?? null,
                      thread.environment?.id ?? null,
                      gitButlerLabels,
                    )}
                    isActive={thread.id === activeThreadId}
                    canPark={lifecycle.canPark(thread)}
                    isCompactViewport={isCompactViewport}
                    onNavigate={onNavigate}
                    onSettle={() => settleAndAdvance(thread.id, waiting)}
                    onSnooze={(until) => lifecycle.snooze(thread.id, until)}
                    now={now}
                  />
                ))}
              </Shelf>
            ) : null}
            <ParkedShelf
              label="Snoozed"
              shelf="snoozed"
              threads={snoozed}
              expanded={showSnoozed}
              onToggle={() => setShowSnoozed((open) => !open)}
              activeThreadId={activeThreadId}
              wakeAtFor={lifecycle.wakeAtFor}
              onRestore={lifecycle.unsnooze}
              isCompactViewport={isCompactViewport}
              onNavigate={onNavigate}
              now={now}
            />
            <ParkedShelf
              label="Settled"
              shelf="settled"
              threads={settled}
              expanded={showSettled}
              onToggle={() => setShowSettled((open) => !open)}
              activeThreadId={activeThreadId}
              wakeAtFor={() => null}
              onRestore={settledThreads.unsettle}
              isCompactViewport={isCompactViewport}
              onNavigate={onNavigate}
              now={now}
            />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * A collapsed shelf of parked threads. The header stays while anything is
 * parked — the count is the whole footprint when collapsed — and the shelf
 * vanishes entirely at zero.
 */
function ParkedShelf({
  label,
  shelf,
  threads,
  expanded,
  onToggle,
  activeThreadId,
  wakeAtFor,
  onRestore,
  isCompactViewport,
  onNavigate,
  now,
}: {
  label: string;
  shelf: "snoozed" | "settled";
  threads: readonly PluginSidebarThread[];
  expanded: boolean;
  onToggle: () => void;
  activeThreadId: string | null;
  wakeAtFor: (thread: PluginSidebarThread) => number | null;
  onRestore: (threadId: string) => void;
  isCompactViewport: boolean;
  onNavigate: () => void;
  /** Quantized clock, shared by every row — never a fresh read, which a
   * seeded first paint could now disagree with. */
  now: number;
}) {
  const count = threads.length;
  if (count === 0) return null;
  return (
    <section aria-label={label}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        // Padded like a card, so the chevron ends on the same right edge as
        // every row's status and provider glyph. `cursor-pointer` is explicit
        // because Tailwind v4's preflight gives a button `cursor: default`,
        // and the whole header is the hit target for collapsing the shelf.
        className={cn(
          "mt-2 flex w-full cursor-pointer items-center gap-2 px-2.5 text-left",
          isCompactViewport ? "min-h-10" : "pb-0.5",
        )}
      >
        <span
          className={cn(
            "text-2xs font-medium",
            isCompactViewport ? "text-muted-foreground" : "text-muted-foreground/70",
          )}
        >
          {expanded ? label : `${label} (${count})`}
        </span>
        <span className="h-px flex-1 bg-sidebar-border" />
        <span className={TRAILING_GLYPH_BOX_CLASS}>
          <Icon
            name="ChevronDown"
            className={cn(
              "size-3 transition-transform",
              isCompactViewport ? "text-muted-foreground" : "text-muted-foreground/70",
              expanded && "rotate-180",
            )}
          />
        </span>
      </button>
      {expanded ? (
        <ul className="flex flex-col gap-0.5">
          {threads.map((thread) => (
            <SlimRow
              key={thread.id}
              thread={thread}
              isActive={thread.id === activeThreadId}
              shelf={shelf}
              wakeAt={wakeAtFor(thread)}
              now={now}
              isCompactViewport={isCompactViewport}
              onNavigate={onNavigate}
              onRestore={() => onRestore(thread.id)}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function Shelf({
  label,
  children,
  isCompactViewport,
}: {
  label: string | null;
  children: React.ReactNode;
  isCompactViewport: boolean;
}) {
  return (
    // A named section is exposed as a landmark region; an unnamed one is not,
    // which is exactly right for the single unlabelled inbox list.
    <section {...(label ? { "aria-label": label } : {})}>
      {label ? (
        <h2 className={cn("flex items-center gap-2 px-2.5 pb-0.5 pt-2")}>
          <span
            className={cn(
              "text-2xs font-medium",
              isCompactViewport ? "text-muted-foreground" : "text-muted-foreground/70",
            )}
          >
            {label}
          </span>
          <span className="h-px flex-1 bg-sidebar-border" />
        </h2>
      ) : null}
      {/* Cards need a real gap, not a hairline: their own padding is 6px, so a
          1px seam let two stacked cards read as one block. Slim rows below get
          less — a single centred line already carries its own air. */}
      <ul className="flex flex-col gap-1">{children}</ul>
    </section>
  );
}
