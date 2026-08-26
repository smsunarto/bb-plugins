import { useEffect, useMemo, useRef, useState } from "react";
import {
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
import { mergeSettledThreads, pendingSettledCount } from "@/lib/settled-threads";
import { TRAILING_GLYPH_BOX_CLASS } from "@/components/inbox/status-slot";
import {
  type ActiveSectionOrder,
  filterByProject,
  hideChildrenOfVisibleParents,
  partitionActiveSections,
  partitionPinned,
  reconcileActiveSectionOrder,
  searchThreadsByTitle,
  sortByCreatedAtDescending,
  visibleInboxThreads,
} from "@/lib/inbox";
import { readWarmStartProviders, writeWarmStartProviders } from "@/lib/warm-start";
import { resolveSidebarBranchLabel } from "@/lib/gitbutler";
import { useThreadPullRequests } from "@/hooks/use-thread-pull-requests";

const ALL_PROJECTS = "__all__";
const EMPTY_STATE_CLASS = "px-2 py-6 text-center text-xs text-muted-foreground";
const GITBUTLER_REFRESH_MS = 30_000;

/**
 * The sidebar's scrolling list: cards grouped by who can act next.
 *
 * The host owns the New-thread button and the search field above it, so this
 * ships neither. It filters by the `searchQuery` prop and keeps only the one
 * control the host has no equivalent for: the project scope picker.
 */
export function ThreadInbox({ activeThreadId, onNavigate, searchQuery }: PluginThreadListProps) {
  const { status, threads: hostThreads, projects } = useSidebarThreads();
  const rpc = useRpc<typeof gtdSidebarRpcContract>();
  // One clock for every card in a render, quantized to the minute so the
  // labels do not disagree and do not churn on unrelated re-renders. It is
  // read first because the settled shelf's day-long window is cut against it.
  const [nowMinute, setNowMinute] = useState(() => Math.floor(Date.now() / 60_000));
  useEffect(() => {
    const timer = setInterval(() => setNowMinute(Math.floor(Date.now() / 60_000)), 60_000);
    return () => clearInterval(timer);
  }, []);
  const now = nowMinute * 60_000;
  // The host reports no archived thread, and settling archives one. Everything
  // below — the shelves, the un-settle rule, search, the project scope — reads
  // this merged list so the settled shelf has rows to draw at all.
  const { threads: settledThreads, rowsPending: settledRowsPending } = useSettledThreads(now);
  const threads = useMemo(
    () => mergeSettledThreads(hostThreads, settledThreads),
    [hostThreads, settledThreads],
  );
  const lifecycle = useLifecycle(threads);
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
  const debugPullRequests = settingValues?.debugPullRequests === true;

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

  const pullRequestByThreadId = useThreadPullRequests(threads, gitButlerLabels);

  const projectNameById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );

  // Entrance order observes the whole active, unpinned set. Project scope,
  // search, and child hiding are presentation filters; applying them here
  // would make hiding and showing a row look like a new section entrance.
  const activeUnpinned = useMemo(
    () =>
      visibleInboxThreads(threads, lifecycle.parkedThreadIds).filter(
        (thread) => !thread.isPinned && lifecycle.shelfFor(thread) === "active",
      ),
    [lifecycle, threads],
  );
  const activeSectionOrderRef = useRef<ActiveSectionOrder | null>(null);
  const activeSectionOrder = reconcileActiveSectionOrder(
    activeSectionOrderRef.current,
    activeUnpinned,
  );
  activeSectionOrderRef.current = activeSectionOrder;

  const { pinned, nextAction, waiting, snoozed, settled } = useMemo(() => {
    const scoped = filterByProject(
      // Settling archives the thread in bb, so the parked set is what keeps
      // the settled shelf from filtering itself away.
      visibleInboxThreads(threads, lifecycle.parkedThreadIds),
      scope === ALL_PROJECTS ? null : scope,
    );
    // Children live in their parent's header chip instead of the flat list;
    // an orphan whose parent is not on screen stays here.
    const matched = searchThreadsByTitle(hideChildrenOfVisibleParents(scoped), searchQuery);
    const active: typeof matched = [];
    const onSnoozeShelf: typeof matched = [];
    const onSettledShelf: typeof matched = [];
    for (const thread of matched) {
      const shelf = lifecycle.shelfFor(thread);
      if (shelf === "snoozed") onSnoozeShelf.push(thread);
      else if (shelf === "settled") onSettledShelf.push(thread);
      else active.push(thread);
    }
    const split = partitionPinned(active);
    const activeSections = partitionActiveSections(split.inbox, activeSectionOrder);
    return {
      pinned: sortByCreatedAtDescending(split.pinned),
      ...activeSections,
      // Soonest wake first: "what comes back next" is the shelf's question.
      snoozed: [...onSnoozeShelf].sort(
        (left, right) => (lifecycle.wakeAtFor(left) ?? 0) - (lifecycle.wakeAtFor(right) ?? 0),
      ),
      settled: sortByCreatedAtDescending(onSettledShelf),
    };
  }, [activeSectionOrder, lifecycle, scope, searchQuery, threads]);

  // The settled shelf's rows arrive on a second and slower read, while the
  // lifecycle rows naming those same threads are already warm. Counting them is
  // what lets the collapsed header draw itself on the first frame instead of
  // popping in a round trip late — and, because the total below is what decides
  // the empty state, it is also the only thing standing between a user whose
  // threads are all settled and a "No threads yet" that is simply false.
  //
  // Only while that read still owes an answer. Once one has resolved, a row it
  // did not bring back is a row it CANNOT bring back — a thread deleted while
  // the plugin was stopped, or one sitting past the backend's archived-listing
  // cap — and counting those past the round trip would leave a header standing
  // over a list nothing will ever fill.
  //
  // A search or a project scope suppresses it. The count is global and knows
  // neither a title nor a project, so drawing it under a filter would claim
  // matches this frame cannot back up; falling to zero there leaves the filter
  // behaving exactly as it did before.
  const pendingSettled = useMemo(() => {
    if (!settledRowsPending) return 0;
    if (searchQuery.trim().length > 0 || scope !== ALL_PROJECTS) return 0;
    return pendingSettledCount(
      lifecycle.parkedRows.values(),
      new Set(threads.map((thread) => thread.id)),
      now,
    );
  }, [lifecycle.parkedRows, now, scope, searchQuery, settledRowsPending, threads]);

  const shelvedTotal =
    pinned.length +
    nextAction.length +
    waiting.length +
    snoozed.length +
    settled.length +
    pendingSettled;

  const scopeLabel =
    scope === ALL_PROJECTS ? "All projects" : (projectNameById.get(scope) ?? "All projects");

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
            className="h-6 min-w-0 flex-1 border-0 border-transparent px-1.5 py-1 text-xs font-medium text-muted-foreground shadow-none hover:bg-sidebar-accent focus:ring-0"
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

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {/* Five outcomes, and the order carries the argument. The unready one
            renders nothing rather than "No threads yet" — bb's threads are
            already here, so what is still missing is this plugin's own rows,
            and a false empty state is worse than a blank moment. It comes
            after the error branch so a failed thread query still says so, and
            it is reached whenever nothing seeded the shelves: a first-ever
            run, a cleared origin, or any browser with web storage switched
            off or partitioned, where the seed misses on every page load.
            `shelvesReady`'s own deadline is behind all of them.

            There is deliberately no second gate for the settled rows. The
            shelves are ready by then, so waiting on the slower read would blank
            pinned and active sections, and snoozed — every one of them already
            in hand — to protect one line at the bottom, and any wait bounded
            enough not to hang the sidebar ends by opening on the same false
            empty state it postponed. `shelvedTotal` counts the settled rows
            still in flight instead. That closes this branch outright on a
            cache HIT: the rows are already there, so a user whose threads are
            all settled has a non-zero total from the first frame. On a MISS it
            only shortens the exposure — there is nothing to count, so once
            `SHELF_GATE_MS` gives up on a `listLifecycle` still in flight the
            branch is reachable again and says "No threads yet" until that read
            lands. Nothing short of the seed can close it there: on a cold
            origin the plugin knows nothing about this user at all. */}
        {status === "loading" ? null : status === "error" ? (
          // `output` is for calculation results; a polite live region for a
          // status message is exactly what `role="status"` is for.
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
          <p role="status" className={EMPTY_STATE_CLASS}>
            Could not load threads.
          </p>
        ) : !lifecycle.shelvesReady ? null : shelvedTotal === 0 ? (
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
          <p role="status" className={EMPTY_STATE_CLASS}>
            {searchQuery.trim() ? "No threads found" : "No threads yet"}
          </p>
        ) : (
          <>
            {pinned.length > 0 ? (
              <Shelf label="Pinned">
                {pinned.map((thread) => (
                  <ThreadCard
                    key={thread.id}
                    thread={thread}
                    provider={providerInfoById.get(thread.providerId)}
                    showProviderIcon={showProviderIcon}
                    debugPullRequests={debugPullRequests}
                    pullRequest={pullRequestByThreadId.get(thread.id) ?? null}
                    projectName={projectNameById.get(thread.projectId) ?? null}
                    branchName={resolveSidebarBranchLabel(
                      thread.environment?.branchName ?? null,
                      thread.environment?.id ?? null,
                      gitButlerLabels,
                    )}
                    isActive={thread.id === activeThreadId}
                    canPark={lifecycle.canPark(thread)}
                    onNavigate={onNavigate}
                    onSettle={() => lifecycle.settle(thread.id)}
                    onSnooze={(until, pullRequestUrl) =>
                      lifecycle.snooze(thread.id, until, pullRequestUrl)
                    }
                    now={now}
                  />
                ))}
              </Shelf>
            ) : null}
            {nextAction.length > 0 ? (
              <Shelf label="Next Action">
                {nextAction.map((thread) => (
                  <ThreadCard
                    key={thread.id}
                    thread={thread}
                    provider={providerInfoById.get(thread.providerId)}
                    showProviderIcon={showProviderIcon}
                    debugPullRequests={debugPullRequests}
                    pullRequest={pullRequestByThreadId.get(thread.id) ?? null}
                    projectName={projectNameById.get(thread.projectId) ?? null}
                    branchName={resolveSidebarBranchLabel(
                      thread.environment?.branchName ?? null,
                      thread.environment?.id ?? null,
                      gitButlerLabels,
                    )}
                    isActive={thread.id === activeThreadId}
                    canPark={lifecycle.canPark(thread)}
                    onNavigate={onNavigate}
                    onSettle={() => lifecycle.settle(thread.id)}
                    onSnooze={(until, pullRequestUrl) =>
                      lifecycle.snooze(thread.id, until, pullRequestUrl)
                    }
                    now={now}
                  />
                ))}
              </Shelf>
            ) : null}
            {waiting.length > 0 ? (
              <Shelf label="Waiting">
                {waiting.map((thread) => (
                  <ThreadCard
                    key={thread.id}
                    thread={thread}
                    provider={providerInfoById.get(thread.providerId)}
                    showProviderIcon={showProviderIcon}
                    debugPullRequests={debugPullRequests}
                    pullRequest={pullRequestByThreadId.get(thread.id) ?? null}
                    projectName={projectNameById.get(thread.projectId) ?? null}
                    branchName={resolveSidebarBranchLabel(
                      thread.environment?.branchName ?? null,
                      thread.environment?.id ?? null,
                      gitButlerLabels,
                    )}
                    isActive={thread.id === activeThreadId}
                    canPark={lifecycle.canPark(thread)}
                    onNavigate={onNavigate}
                    onSettle={() => lifecycle.settle(thread.id)}
                    onSnooze={(until, pullRequestUrl) =>
                      lifecycle.snooze(thread.id, until, pullRequestUrl)
                    }
                    now={now}
                  />
                ))}
              </Shelf>
            ) : null}
            <ParkedShelf
              label="Snoozed"
              threads={snoozed}
              expanded={showSnoozed}
              onToggle={() => setShowSnoozed((open) => !open)}
              shelf="snoozed"
              activeThreadId={activeThreadId}
              lifecycle={lifecycle}
              onNavigate={onNavigate}
              now={now}
            />
            <ParkedShelf
              label="Settled"
              threads={settled}
              pendingCount={pendingSettled}
              expanded={showSettled}
              onToggle={() => setShowSettled((open) => !open)}
              shelf="settled"
              activeThreadId={activeThreadId}
              lifecycle={lifecycle}
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
 * vanishes entirely at zero. A thread whose row has not arrived counts as
 * parked: this shelf is the only place it can be, and a header that turned up a
 * round trip later would be the flicker the count exists to remove.
 */
function ParkedShelf({
  label,
  threads,
  pendingCount = 0,
  expanded,
  onToggle,
  shelf,
  activeThreadId,
  lifecycle,
  onNavigate,
  now,
}: {
  label: string;
  threads: readonly PluginSidebarThread[];
  /**
   * Threads this shelf owns whose rows have not arrived yet. Only the settled
   * shelf has a second, slower source to wait on, so only it passes one, and it
   * falls to zero the moment that read answers — with the rows, or without the
   * ones it turns out it cannot resolve. Expanding inside that window draws a
   * header over an empty list, costing one line of nothing and a second click.
   *
   * "That window" is a round trip only while the read is answering. A backend
   * that cannot list archived threads at all never answers, and the header then
   * stands over an empty list for as long as the rows stay inside the settled
   * window. That is the deliberate direction: the alternative is telling a user
   * whose threads are all settled that they have none.
   */
  pendingCount?: number;
  expanded: boolean;
  onToggle: () => void;
  shelf: "snoozed" | "settled";
  activeThreadId: string | null;
  lifecycle: ReturnType<typeof useLifecycle>;
  onNavigate: () => void;
  /** Quantized clock, shared by every row — never a fresh read, which a
   * seeded first paint could now disagree with. */
  now: number;
}) {
  const count = threads.length + pendingCount;
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
        className="mt-2 flex w-full cursor-pointer items-center gap-2 px-2.5 pb-0.5 text-left"
      >
        <span className="text-2xs font-medium text-muted-foreground/70">
          {expanded ? label : `${label} (${count})`}
        </span>
        <span className="h-px flex-1 bg-sidebar-border" />
        <span className={TRAILING_GLYPH_BOX_CLASS}>
          <Icon
            name="ChevronDown"
            className={cn(
              "size-3 text-muted-foreground/70 transition-transform",
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
              wakeAt={lifecycle.wakeAtFor(thread)}
              now={now}
              onNavigate={onNavigate}
              onRestore={() =>
                shelf === "snoozed" ? lifecycle.unsnooze(thread.id) : lifecycle.unsettle(thread.id)
              }
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function Shelf({ label, children }: { label: string | null; children: React.ReactNode }) {
  return (
    // A named section is exposed as a landmark region; an unnamed one is not,
    // which is exactly right for the single unlabelled inbox list.
    <section {...(label ? { "aria-label": label } : {})}>
      {label ? (
        <h2 className={cn("flex items-center gap-2 px-2.5 pb-0.5 pt-2")}>
          <span className="text-2xs font-medium text-muted-foreground/70">{label}</span>
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
