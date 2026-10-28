// Environments: the reply's thread's project's environments (the project
// checkout, worktrees, other workspaces) as a dashboard of parallel work. The
// list and the threads on each environment come first (project_environments);
// each row's git status and pull request are read when the row is on screen,
// a few at a time (project_environment). A row opens its newest thread in BB,
// each thread line its own thread. Read-only: nothing here changes a checkout.
// It polls, with backoff, only while visible and while a thread runs.
import { useCallback, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";
import { UrlLink, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  aheadBehindLabel,
  environmentTitle,
  kindLabel,
  LIFE_LABEL,
  liveThreads,
  openingThread,
  threadSummary,
  type CheckoutStatus,
  type EnvironmentDetailResult,
  type EnvironmentInfo,
  type EnvironmentKind,
  type EnvironmentLife,
  type EnvironmentPull,
  type EnvironmentThread,
  type EnvironmentsView,
} from "../../core/environments";
import { checkCounts, CHECKS_LABEL, PR_STATE_LABEL, relativeTime, RUNNING, threadStatusLabel, type EnvironmentsResult } from "../../core/project";
import type { rpcContract } from "../../server";
import { useUiRuntime } from "../runtime";
import { propsKey, usePersistedState } from "../usePersistedState";
import { formatNumber, TONE_DOT, TONE_PILL, TONE_TEXT, type Props, type Tone } from "../values";
import { DETAIL_CONCURRENCY, detailsDue, ENVIRONMENT_PAGE, shownEnvironments } from "./environments-logic";
import { FOCUS_RING } from "./inputs";
import { RISE, SMOOTH_HEIGHT_CLASS, useEntrance, useSmoothHeight } from "./motion";
import {
  EXACT_TIME,
  FailureLine,
  Freshness,
  LoadingRows,
  NeedsThread,
  Panel,
  QuietLine,
  ShowAll,
  useNow,
  useProjectQuery,
  useVisible,
} from "./projectKit";
import { CHECKS_TONE, STATE_ICON, STATE_TONE } from "./pullRequest";
import { LiveDot, statusTone } from "./threads";

/** Thread lines a row lists; the rest are counted. */
const THREAD_LINES = 3;

const KIND_ICON: Record<EnvironmentKind, string> = {
  checkout: "FolderGit",
  worktree: "GitBranch",
  "managed-worktree": "GitBranch",
  personal: "UserRound",
  folder: "Folder",
  other: "ComputerCloud",
};

const LIFE_TONE: Record<EnvironmentLife, Tone> = {
  ready: "neutral",
  creating: "info",
  error: "bad",
  retiring: "warn",
  destroyed: "neutral",
  "host-gone": "warn",
};

/** The details read so far per thread and environment, kept across remounts so a row reopens with what it showed. */
const detailCache = new Map<string, { readonly at: number; readonly result: EnvironmentDetailResult }>();

export function Environments({ props }: { props: Props }) {
  const { threadId } = useUiRuntime();
  if (threadId === null) {
    return (
      <NeedsThread icon="FolderGit">
        <span className="font-medium text-foreground">Environments</span> needs a thread: in a reply it shows that thread's project's
        checkout and worktrees, the threads on each, their uncommitted changes and pull requests.
      </NeedsThread>
    );
  }
  return <EnvironmentsPanel threadId={threadId} stateId={`${propsKey(props)}:environments`} />;
}

interface ViewState {
  readonly all: boolean;
  readonly pages: number;
}

function acceptView(stored: unknown): ViewState | null {
  if (typeof stored !== "object" || stored === null) return null;
  const { all, pages } = stored as Record<string, unknown>;
  return typeof all === "boolean" && typeof pages === "number" && Number.isInteger(pages) && pages >= 1 ? { all, pages } : null;
}

function EnvironmentsPanel({ threadId, stateId }: { threadId: string; stateId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [ref, visible] = useVisible<HTMLDivElement>();
  const { query, refresh } = useProjectQuery<EnvironmentsResult>(
    `environments\0${threadId}`,
    () => rpc.call("project_environments", { threadId }),
    { visible, live: (answer) => answer.ok && answer.environments.some((environment) => environment.threadCounts.running > 0) },
  );
  const now = useNow(15_000);
  const answer = query.status === "ready" ? query.answer : null;
  const view = answer?.ok ? answer : null;
  const details = useDetails(threadId, view, (environmentId) => rpc.call("project_environment", { threadId, environmentId }));
  const running = view === null ? 0 : view.environments.reduce((sum, environment) => sum + environment.threadCounts.running, 0);
  const waiting = view === null ? 0 : view.environments.reduce((sum, environment) => sum + environment.threadCounts.needsInput, 0);
  const onRefresh = useCallback(() => {
    details.forget();
    void refresh();
  }, [details, refresh]);
  return (
    <div ref={ref} className="min-w-0">
      <Panel
        label="Environments"
        header={
          <>
            <span className="flex min-w-0 items-center gap-1.5">
              <Icon name="FolderGit" aria-hidden className="size-3.5 shrink-0" />
              <span className="font-medium text-foreground">Environments</span>
              {view === null ? null : <span className="tabular-nums">{formatNumber(view.environments.length)}</span>}
            </span>
            {running > 0 ? (
              <span className="flex items-center gap-1.5 tabular-nums">
                <LiveDot tone="info" live />
                {running} running
              </span>
            ) : null}
            {waiting > 0 ? <span className={cn("tabular-nums", TONE_TEXT.warn)}>{waiting} need input</span> : null}
            {view === null ? null : (
              <Freshness at={view.fetchedAt} stored={false} refreshing={query.status === "ready" && query.refreshing} onRefresh={onRefresh} now={now} />
            )}
          </>
        }
      >
        {answer === null ? (
          <LoadingRows label="Loading environments" />
        ) : !answer.ok ? (
          <FailureLine failure={answer} />
        ) : (
          <EnvironmentList view={answer} details={details} now={now} stateId={stateId} />
        )}
      </Panel>
    </div>
  );
}

interface Details {
  get(environmentId: string): EnvironmentDetailResult | null;
  /** Watches a row: its detail is read while it is on screen. Returns the unwatch. */
  watch(element: Element, environmentId: string): () => void;
  /** Drops what was read for the rows on screen and reads them again (Refresh). */
  forget(): void;
}

/**
 * Each environment's git status and pull request, read for the rows on
 * screen, DETAIL_CONCURRENCY at a time; rows with a running thread are read
 * again once their detail is LIVE_DETAIL_MS old (on the list's next poll).
 */
function useDetails(threadId: string, view: EnvironmentsView | null, read: (environmentId: string) => Promise<EnvironmentDetailResult>): Details {
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const reader = useRef(read);
  reader.current = read;
  const onScreen = useRef(new Set<string>());
  const reading = useRef(new Set<string>());
  const environments = useMemo(() => new Map((view?.environments ?? []).map((environment) => [environment.id, environment])), [view]);
  const order = useMemo(() => (view?.environments ?? []).map((environment) => environment.id), [view]);
  const key = (environmentId: string) => `${threadId}\0${environmentId}`;

  const pump = useRef(() => {});
  pump.current = () => {
    const free = DETAIL_CONCURRENCY - reading.current.size;
    if (free <= 0) return;
    const readAt = new Map<string, number>();
    for (const id of order) {
      const cached = detailCache.get(key(id));
      if (cached !== undefined) readAt.set(id, cached.at);
    }
    const due = detailsDue(
      order.filter((id) => onScreen.current.has(id)),
      environments,
      readAt,
      reading.current,
      Date.now(),
    ).slice(0, free);
    for (const id of due) {
      reading.current.add(id);
      void reader.current(id)
        .catch((cause: unknown): EnvironmentDetailResult => ({ ok: false, reason: "unavailable", message: cause instanceof Error ? cause.message : String(cause) }))
        .then((result) => {
          detailCache.set(key(id), { at: Date.now(), result });
          reading.current.delete(id);
          rerender();
          pump.current();
        });
    }
  };

  // A new list (first read, a poll, a refresh) may bring rows whose detail is due.
  useEffect(() => pump.current(), [view]);

  const observer = useRef<IntersectionObserver | null>(null);
  const ids = useRef(new WeakMap<Element, string>());
  // Rows' effects run before this component's, so the observer is made by the first row that asks for it.
  const observing = useRef(() => {
    observer.current ??= new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = ids.current.get(entry.target);
          if (id === undefined) continue;
          if (entry.isIntersecting) onScreen.current.add(id);
          else onScreen.current.delete(id);
        }
        pump.current();
      },
      { rootMargin: "200px 0px" },
    );
    return observer.current;
  });
  useEffect(
    () => () => {
      observer.current?.disconnect();
      observer.current = null;
    },
    [],
  );

  return useMemo<Details>(
    () => ({
      get: (environmentId) => detailCache.get(`${threadId}\0${environmentId}`)?.result ?? null,
      watch(element, environmentId) {
        ids.current.set(element, environmentId);
        observing.current().observe(element);
        return () => {
          observer.current?.unobserve(element);
          onScreen.current.delete(environmentId);
        };
      },
      forget() {
        for (const id of onScreen.current) detailCache.delete(`${threadId}\0${id}`);
        pump.current();
      },
    }),
    [threadId],
  );
}

function EnvironmentList({ view, details, now, stateId }: { view: EnvironmentsView; details: Details; now: number; stateId: string }) {
  const [state, setState] = usePersistedState<ViewState>(stateId, { all: false, pages: 1 }, acceptView);
  const { outer, inner } = useSmoothHeight<HTMLDivElement, HTMLDivElement>();
  if (view.environments.length === 0) {
    return <QuietLine className="px-3 py-2.5">This project has no environments.</QuietLine>;
  }
  const shown = shownEnvironments(view.environments, state.all, state.pages);
  return (
    <div ref={outer} className={cn("min-w-0", SMOOTH_HEIGHT_CLASS)}>
      <div ref={inner} className="min-w-0">
        <ul className="m-0 flex min-w-0 list-none flex-col p-0">
          {shown.rows.map((environment) => (
            <EnvironmentRow key={environment.id} environment={environment} detail={environment.detail ?? details.get(environment.id)} details={details} now={now} />
          ))}
        </ul>
        {shown.hidden > 0 ? (
          <ShowAll count={view.environments.length} noun="environments" onClick={() => setState({ all: true, pages: 1 })} />
        ) : shown.more > 0 ? (
          <MoreButton count={Math.min(ENVIRONMENT_PAGE, shown.more)} onClick={() => setState((previous) => ({ ...previous, pages: previous.pages + 1 }))} />
        ) : null}
        {view.threadsTruncated ? (
          <QuietLine icon="Info" className="border-t border-border/60 px-3 py-2">
            This project has more threads than were read: thread counts may be short.
          </QuietLine>
        ) : null}
      </div>
    </div>
  );
}

function MoreButton({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full cursor-pointer items-center justify-center gap-1 border-t border-border/60 px-3 py-2 text-xs text-muted-foreground transition-colors duration-150 hover:bg-state-hover hover:text-foreground",
        FOCUS_RING,
      )}
    >
      Show {count} more
      <Icon name="ChevronDown" aria-hidden className="size-3.5" />
    </button>
  );
}

function EnvironmentRow({
  environment,
  detail,
  details,
  now,
}: {
  environment: EnvironmentInfo;
  detail: EnvironmentDetailResult | null;
  details: Details;
  now: number;
}) {
  const rise = useEntrance<HTMLLIElement>(RISE);
  const element = useRef<HTMLLIElement | null>(null);
  const setRef = useCallback(
    (node: HTMLLIElement | null) => {
      element.current = node;
      rise.current = node;
    },
    [rise],
  );
  useEffect(() => {
    const node = element.current;
    return node === null ? undefined : details.watch(node, environment.id);
  }, [details, environment.id]);
  const navigate = useBbNavigate();
  const opening = openingThread(environment);
  const title = environmentTitle(environment);
  const life = LIFE_LABEL[environment.life];
  const live = liveThreads(environment);
  const lines = (live.length > 0 ? live : environment.threads).slice(0, live.length > 0 ? THREAD_LINES : 1);
  const unlisted = environment.threadCounts.total - lines.length;
  const heading = (
    <>
      <Icon name={KIND_ICON[environment.kind]} aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className={cn("min-w-0 max-w-full truncate text-[13px] font-medium leading-5 text-foreground", environment.branch !== null && "font-mono text-[12.5px]")}>
          {title}
        </span>
        <span className="min-w-0 truncate text-[11px] leading-4 text-muted-foreground">{kindLabel(environment)}</span>
        {environment.current ? (
          <span className={cn("shrink-0 rounded-full px-1.5 py-px text-[10.5px] font-medium leading-4", TONE_PILL.info)}>this thread</span>
        ) : null}
        {life === null ? null : (
          <span className={cn("shrink-0 rounded-full px-1.5 py-px text-[10.5px] font-medium leading-4", TONE_PILL[LIFE_TONE[environment.life]])}>{life}</span>
        )}
      </span>
      {environment.activeAt === null ? null : (
        <time
          dateTime={new Date(environment.activeAt).toISOString()}
          title={`Last thread activity ${EXACT_TIME.format(environment.activeAt)}`}
          className="shrink-0 text-[11px] leading-5 tabular-nums text-muted-foreground"
        >
          {relativeTime(environment.activeAt, now)}
        </time>
      )}
    </>
  );
  return (
    <li ref={setRef} className="min-w-0 border-b border-border/60 last:border-b-0">
      {opening === null ? (
        <div className="flex min-w-0 items-center gap-2.5 px-3 pt-2" title={environment.path ?? undefined}>
          {heading}
          <span aria-hidden className="size-3.5 shrink-0" />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => navigate.toThread(opening.id)}
          title={`Open “${opening.title}”${environment.path === null ? "" : `\n${environment.path}`}`}
          aria-label={`${title}, ${kindLabel(environment)}: open its newest thread, ${opening.title}`}
          className={cn(
            "group/row flex w-full min-w-0 cursor-pointer items-center gap-2.5 px-3 pt-2 text-left transition-colors duration-150 hover:bg-state-hover",
            FOCUS_RING,
          )}
        >
          {heading}
          <Icon
            name="ChevronRight"
            aria-hidden
            className="size-3.5 shrink-0 text-muted-foreground transition-colors duration-150 group-hover/row:text-foreground"
          />
        </button>
      )}
      <div className="flex min-w-0 flex-col gap-1 pb-2 pl-[2.375rem] pr-3 pt-1">
        <Facts environment={environment} detail={detail} />
        {lines.length === 0 ? (
          <span className="text-[11.5px] leading-5 text-muted-foreground">No threads</span>
        ) : (
          <ul className="-ml-1.5 mb-0 mr-0 mt-0 flex min-w-0 list-none flex-col p-0" aria-label={`Threads on ${title}: ${threadSummary(environment)}`}>
            {lines.map((thread) => (
              <ThreadLine key={thread.id} thread={thread} />
            ))}
            {unlisted > 0 ? (
              <li className="pl-1.5 text-[11px] leading-5 text-muted-foreground">
                +{formatNumber(unlisted)} more ({threadSummary(environment)})
              </li>
            ) : null}
          </ul>
        )}
      </div>
    </li>
  );
}

function ThreadLine({ thread }: { thread: EnvironmentThread }) {
  const navigate = useBbNavigate();
  const tone = statusTone(thread);
  return (
    <li className="min-w-0">
      <button
        type="button"
        onClick={() => navigate.toThread(thread.id)}
        title={`Open “${thread.title}”`}
        className={cn(
          "group/thread flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-sm px-1.5 text-left text-[12px] leading-5 transition-colors duration-150 hover:bg-state-hover",
          FOCUS_RING,
        )}
      >
        <LiveDot tone={tone} live={RUNNING[thread.status] && !thread.archived} />
        <span className={cn("min-w-0 flex-1 truncate", thread.archived ? "text-muted-foreground" : "text-foreground")}>
          {thread.subthread ? <span className="text-muted-foreground">↳ </span> : null}
          {thread.title}
        </span>
        <span className={cn("shrink-0 text-[11px] font-medium", tone === "neutral" ? "text-muted-foreground" : TONE_TEXT[tone])}>{threadStatusLabel(thread)}</span>
      </button>
    </li>
  );
}

/** The row's git line: uncommitted changes, ahead/behind, pull request; or why there is none. Always one line high while loading. */
function Facts({ environment, detail }: { environment: EnvironmentInfo; detail: EnvironmentDetailResult | null }) {
  if (detail === null) {
    return (
      <span role="status" aria-label="Reading git status" className="flex h-5 items-center gap-2">
        <span className="h-2.5 w-24 animate-pulse rounded-sm bg-muted motion-reduce:animate-none" />
        <span className="h-2.5 w-16 animate-pulse rounded-sm bg-muted motion-reduce:animate-none" />
      </span>
    );
  }
  if (!detail.ok) return <FactLine icon="AlertCircle">{detail.message}</FactLine>;
  const checkout = detail.checkout;
  if (!checkout.ok) {
    const icon = checkout.reason === "not-git" ? "Folder" : checkout.reason === "gone" ? "Unavailable" : "FolderUnknown";
    return (
      <FactLine icon={icon} tone={checkout.reason === "missing" ? "warn" : "neutral"} title={checkout.path ?? undefined}>
        {checkout.message}
        {checkout.path === null ? null : <span className="sr-only">: {checkout.path}</span>}
      </FactLine>
    );
  }
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[11.5px] leading-5 text-muted-foreground">
      <Uncommitted status={checkout} />
      <Position status={checkout} environment={environment} />
      {detail.pull === null ? null : <PullFact pull={detail.pull} />}
    </span>
  );
}

function FactLine({ icon, tone = "neutral", title, children }: { icon: string; tone?: Tone; title?: string; children: ReactNode }) {
  return (
    <span title={title} className={cn("flex min-h-5 min-w-0 items-start gap-1.5 text-[11.5px] leading-5", tone === "neutral" ? "text-muted-foreground" : TONE_TEXT[tone])}>
      <Icon name={icon} aria-hidden className="mt-[3px] size-3.5 shrink-0" />
      <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
    </span>
  );
}

function Uncommitted({ status }: { status: CheckoutStatus }) {
  const { files, additions, deletions, complete } = status.uncommitted;
  if (files === 0) return <span title="No uncommitted changes">clean</span>;
  return (
    <span className="flex shrink-0 items-center gap-1 tabular-nums" title={`${files} file${files === 1 ? "" : "s"} with uncommitted changes${complete ? "" : " (some without line counts)"}`}>
      <span className="text-success">+{formatNumber(additions)}</span>
      <span className="text-destructive">−{formatNumber(deletions)}</span>
      <span>
        · {formatNumber(files)} uncommitted {files === 1 ? "file" : "files"}
      </span>
    </span>
  );
}

function Position({ status, environment }: { status: CheckoutStatus; environment: EnvironmentInfo }) {
  if (status.checkout === "detached") return <span className="font-mono">detached {status.head ?? ""}</span>;
  if (status.checkout === "unborn") return <span>no commits yet</span>;
  if (status.onBase) return <span>{status.base === status.defaultBranch ? "default branch" : `on base ${status.base}`}</span>;
  if (status.ahead === null || status.behind === null) return <span>no merge base with {status.base}</span>;
  // The branch BB recorded may lag the checkout: say what is checked out when it differs.
  const moved = status.branch !== null && status.branch !== environment.branch;
  return (
    <span className="flex min-w-0 items-center gap-1.5 tabular-nums" title={aheadBehindLabel(status)}>
      <span className={cn("flex items-center", status.ahead > 0 && "text-foreground")}>
        <Icon name="ArrowUp" aria-hidden className="size-3" />
        {formatNumber(status.ahead)}
      </span>
      <span className={cn("flex items-center", status.behind > 0 && TONE_TEXT.warn)}>
        <Icon name="ArrowDown" aria-hidden className="size-3" />
        {formatNumber(status.behind)}
      </span>
      <span className="min-w-0 truncate font-mono">{status.base}</span>
      <span className="sr-only">{aheadBehindLabel(status)}</span>
      {moved ? <span className="min-w-0 truncate">· on {status.branch}</span> : null}
    </span>
  );
}

function PullFact({ pull }: { pull: EnvironmentPull }) {
  if (!pull.ok) {
    return (
      <span className="flex items-center gap-1" title={pull.message}>
        <Icon name="GitPullRequest" aria-hidden className="size-3.5" />
        PR unknown
      </span>
    );
  }
  const pr = pull.pullRequest;
  if (pr === null) {
    return (
      <span className="flex items-center gap-1">
        <Icon name="GitPullRequest" aria-hidden className="size-3.5" />
        no PR
      </span>
    );
  }
  const counts = checkCounts(pr.checks);
  const checksShown = pr.state === "open" || pr.state === "draft";
  return (
    <UrlLink
      href={pr.url}
      title={`#${pr.number} ${pr.title}\n${PR_STATE_LABEL[pr.state]} · ${CHECKS_LABEL[pr.checks.state]}${counts === "" ? "" : ` (${counts})`}`}
      className={cn("flex min-w-0 items-center gap-1 rounded-sm text-muted-foreground no-underline hover:text-foreground hover:underline", FOCUS_RING)}
    >
      <Icon name={STATE_ICON[pr.state]} aria-hidden className={cn("size-3.5 shrink-0", TONE_TEXT[STATE_TONE[pr.state]])} />
      <span className="tabular-nums text-foreground">#{pr.number}</span>
      <span>{PR_STATE_LABEL[pr.state]}</span>
      {checksShown && pr.checks.state !== "no_checks" ? (
        <span className="flex items-center gap-1">
          <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[CHECKS_TONE[pr.checks.state]], pr.checks.state === "pending" && "animate-pulse motion-reduce:animate-none")} />
          {CHECKS_LABEL[pr.checks.state].replace("Checks ", "checks ")}
        </span>
      ) : null}
    </UrlLink>
  );
}
