import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { KeyboardEvent, RefObject } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { pluginQueryClient } from "@bb-kit/core/rpc/query";
import type { UseQueryResult } from "@tanstack/react-query";
import { prKey, sameRevision } from "../shared/schema.ts";
import type {
  ChangedFile,
  ChangedFiles,
  DiffSide,
  Finding,
  LocalBranch,
  PullRequest,
  ReviewThread,
} from "../shared/schema.ts";
import { reviewSubject, useAgentActivity } from "./bb-review.tsx";
import type { ReviewTarget } from "./bb-review.tsx";
import { Button } from "./components/ui/button.tsx";
import { CONTROL_HOVER_TRANSITION } from "./components/ui/motion.ts";
import { Input } from "./components/ui/input.tsx";
import { DiffFile, startsFolded } from "./diff-file.tsx";
import type { DiffStyle } from "./diff-file.tsx";
import { REVEAL_EVENT } from "./finding.tsx";
import type { RevealDetail } from "./finding.tsx";
import { plural } from "./format.ts";
import { useStoredChoice } from "./hooks/useStoredChoice.ts";
import { cn, keepInView } from "./lib/utils.ts";
import { Loading, Notice, RetryButton, errorText } from "./notice.tsx";
import { ReviewThreadView } from "./review-thread.tsx";
import { rpc } from "./rpc.ts";
import { SyncState } from "./sync-state.tsx";
import { useBranchReviewed } from "./branch-review.ts";
import {
  dismissViewedErrors,
  useViewedErrors,
  useViewedToggle,
  usePrMarks,
  useBranchMarks,
} from "./review-marks.ts";
import type { ReviewMarks } from "./review-marks.ts";

/*
 * The Changes tab: every changed file's diff, with review threads and bb
 * findings inline, a file list to jump around in, and GitHub's per-viewer
 * "Viewed" marks. It scrolls on its own, so the file list and the summary
 * bar stay put while the diffs move. An unpublished branch's tab is the same
 * with local review marks and without GitHub threads or comments.
 */

/** Room left above a card or line the tab scrolls to. */
const SCROLL_MARGIN_PX = 8;
/** How long a revealed file is held in place while the diffs above it render. */
const PIN_MS = 1_500;

// ── Reveal requests ──────────────────────────────────────────────────────

/*
 * "Show in Changes" navigates to this tab, then fires `REVEAL_EVENT`. The tab
 * may mount after the event, so the request is caught here, at load, and held
 * until a tab takes it. One left untaken past `REVEAL_TTL_MS` was meant for a
 * tab that never opened, and a later visit ignores it. The tab takes it as it
 * mounts, before its files load, so a slow load cannot age it out.
 */
const REVEAL_TTL_MS = 5_000;
type RevealRequest = RevealDetail & { at: number };

let pendingReveal: RevealRequest | null = null;
const revealListeners = new Set<() => void>();

function setPendingReveal(next: RevealRequest | null): void {
  pendingReveal = next;
  for (const listener of revealListeners) listener();
}

if (typeof window !== "undefined") {
  window.addEventListener(REVEAL_EVENT, (event) => {
    const detail = (event as CustomEvent<Partial<RevealDetail> | null>).detail;
    if (typeof detail?.path !== "string") return;
    setPendingReveal({
      path: detail.path,
      line: typeof detail.line === "number" ? detail.line : 0,
      side: detail.side === "LEFT" ? "LEFT" : "RIGHT",
      at: Date.now(),
    });
  });
}

function usePendingReveal(): RevealRequest | null {
  return useSyncExternalStore(
    (listener) => {
      revealListeners.add(listener);
      return () => revealListeners.delete(listener);
    },
    () => pendingReveal,
  );
}

// ── Preferences ──────────────────────────────────────────────────────────

const DIFF_STYLES: readonly DiffStyle[] = ["unified", "split"];

// ── Helpers ──────────────────────────────────────────────────────────────

const EMPTY_THREADS: readonly ReviewThread[] = [];
const EMPTY_FINDINGS: readonly Finding[] = [];

function groupByPath<T extends { path: string }>(items: readonly T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(item.path);
    if (group) group.push(item);
    else groups.set(item.path, [item]);
  }
  return groups;
}

/** A viewed file, a generated one, and one too long to draw at once, start folded. */
function startsOpen(file: ChangedFile): boolean {
  return file.viewed !== "viewed" && !startsFolded(file);
}

/** GitHub's order, with generated files moved to the end, as they need the least reading. */
function readingOrder(files: readonly ChangedFile[]): ChangedFile[] {
  return [...files.filter((file) => !file.generated), ...files.filter((file) => file.generated)];
}

function matches(file: Pick<ChangedFile, "path" | "previousPath">, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  return (
    needle === "" ||
    file.path.toLowerCase().includes(needle) ||
    (file.previousPath?.toLowerCase().includes(needle) ?? false)
  );
}

/** Scrolls `container` so `element` sits `margin` below its top edge. Not `scrollIntoView`, which also scrolls bb's own layout. */
function scrollWithin(container: HTMLElement, element: Element, margin: number): void {
  const offset = element.getBoundingClientRect().top - container.getBoundingClientRect().top;
  container.scrollTop += offset - margin;
}

function cardFor(list: HTMLElement, path: string): HTMLElement | null {
  for (const card of list.querySelectorAll<HTMLElement>("[data-file-card]")) {
    if (card.dataset.fileCard === path) return card;
  }
  return null;
}

/** The selected row inside a card's diff, once Pierre has drawn it. */
function selectedLineIn(card: HTMLElement): Element | null {
  return (
    card.querySelector("diffs-container")?.shadowRoot?.querySelector("[data-selected-line]") ?? null
  );
}

// ── Hooks ────────────────────────────────────────────────────────────────

type LineFocus = { line: number; side: DiffSide };
type Focus = { path: string; line: LineFocus | null };

/**
 * Takes a fresh "Show in Changes" request for this tab, the moment it mounts
 * or the request comes. It waits here for the files, however long they take.
 * The second value lets go of it once acted on.
 */
function useClaimedReveal(): [RevealRequest | null, () => void] {
  const pending = usePendingReveal();
  const [claimed, setClaimed] = useState<RevealRequest | null>(null);
  useEffect(() => {
    if (!pending) return;
    setPendingReveal(null);
    if (Date.now() - pending.at <= REVEAL_TTL_MS) setClaimed(pending);
  }, [pending]);
  const release = useCallback(() => setClaimed(null), []);
  return [claimed, release];
}

/** Acts on the tab's claimed "Show in Changes" request once it has its files. */
function useRevealRequest(
  request: RevealRequest | null,
  release: () => void,
  reveal: (path: string, line: LineFocus | null) => void,
) {
  useEffect(() => {
    if (!request) return;
    release();
    reveal(request.path, request.line > 0 ? { line: request.line, side: request.side } : null);
  }, [request, release, reveal]);
}

/**
 * Brings the focused file, or its line, into view. The diffs above it mount
 * as they come near and grow past their placeholders, so the target is held
 * in place as the list resizes, until it settles or the reader scrolls.
 */
function usePinFocus(
  scroller: RefObject<HTMLElement | null>,
  list: RefObject<HTMLElement | null>,
  focus: Focus | null,
) {
  useLayoutEffect(() => {
    const area = scroller.current;
    const content = list.current;
    if (!focus || !area || !content) return;
    const place = () => {
      const card = cardFor(content, focus.path);
      if (!card) return;
      const line = focus.line ? selectedLineIn(card) : null;
      // A line sits a third of the way down, below the file's sticky header,
      // with the code before it in view.
      if (line) scrollWithin(area, line, area.clientHeight / 3);
      else scrollWithin(area, card, SCROLL_MARGIN_PX);
    };
    place();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    observer?.observe(content);
    // The reader taking over the scroll, or the time running out, lets go.
    const release = () => observer?.disconnect();
    const timer = window.setTimeout(release, PIN_MS);
    const listening = new AbortController();
    for (const intent of ["wheel", "touchstart", "pointerdown", "keydown"] as const) {
      area.addEventListener(intent, release, { passive: true, signal: listening.signal });
    }
    return () => {
      release();
      window.clearTimeout(timer);
      listening.abort();
    };
  }, [scroller, list, focus]);
}

/**
 * Folding a card the reader is inside, from its sticky header, would leave
 * the scroll where its diff was, among the files after it. Its top is brought
 * back into view instead, as on GitHub. Call the returned function before the
 * card folds: whether the reader is inside it is measured then.
 */
function useFoldInPlace(
  scroller: RefObject<HTMLElement | null>,
  list: RefObject<HTMLElement | null>,
): (path: string) => void {
  const [held, setHeld] = useState<{ path: string } | null>(null);
  useLayoutEffect(() => {
    const area = scroller.current;
    const card = held && list.current ? cardFor(list.current, held.path) : null;
    if (area && card) scrollWithin(area, card, SCROLL_MARGIN_PX);
  }, [scroller, list, held]);
  return useCallback(
    (path: string) => {
      const area = scroller.current;
      const card = list.current ? cardFor(list.current, path) : null;
      if (!area || !card) return;
      const top = area.getBoundingClientRect().top;
      const box = card.getBoundingClientRect();
      if (box.top < top && box.bottom > top) setHeld({ path });
    },
    [scroller, list],
  );
}

/** The file list follows the diff: the topmost card in the top third is current. */
function useCurrentFile(
  scroller: RefObject<HTMLElement | null>,
  list: RefObject<HTMLElement | null>,
  paths: readonly string[],
  setCurrent: (path: string) => void,
) {
  useEffect(() => {
    const area = scroller.current;
    const content = list.current;
    if (!area || !content || typeof IntersectionObserver === "undefined") return;
    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const path = (entry.target as HTMLElement).dataset.fileCard;
          if (path && entry.isIntersecting) visible.add(path);
          else if (path) visible.delete(path);
        }
        const top = paths.find((path) => visible.has(path));
        if (top) setCurrent(top);
      },
      // The band starts a little below the top: a card whose bottom only
      // touches the top edge still counts as intersecting, and would win.
      { root: area, rootMargin: `-${SCROLL_MARGIN_PX + 4}px 0px -66% 0px` },
    );
    for (const card of content.querySelectorAll("[data-file-card]")) observer.observe(card);
    return () => observer.disconnect();
  }, [scroller, list, paths, setCurrent]);
}

/**
 * When each read of files that lag the pull request goes out: at once, then
 * later and later. GitHub's replicas can disagree for a while after a push or
 * a retarget, so a read can come back as old as the one before.
 */
const CATCH_UP_DELAYS_MS = [0, 1_000, 3_000, 10_000];

/**
 * Reads the files again while they are of another head or base than the pull
 * request, so new comments are counted against the diff it shows now. True
 * once the tries run out with the files still behind.
 */
function useCatchUp(pr: PullRequest, changed: ChangedFiles | undefined): boolean {
  const target = `${pr.headRefOid}:${pr.baseRefName}`;
  const behind = changed !== undefined && !sameRevision(changed, pr);
  // The tries belong to the pull request's revision, not to the files' one.
  // A read can come back as any older revision, and starting over on each
  // would read again at once, without end. They start over when the pull
  // request moves, or once the files catch up, so a later slip gets its own.
  const [tries, setTries] = useState({ target, count: 0 });
  const count = tries.target === target && behind ? tries.count : 0;
  if (tries.target !== target || tries.count !== count) setTries({ target, count });
  useEffect(() => {
    if (!behind || count >= CATCH_UP_DELAYS_MS.length) return;
    let live = true;
    const timer = window.setTimeout(async () => {
      await pluginQueryClient.invalidateQueries({
        queryKey: rpc.changedFiles.queryKey({ account: pr.account, ref: pr.ref }),
      });
      if (live) setTries({ target, count: count + 1 });
    }, CATCH_UP_DELAYS_MS[count]);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [target, behind, count, pr.account, pr.ref]);
  return behind && count >= CATCH_UP_DELAYS_MS.length;
}

/**
 * Reads the pull request and its files again. A read already on its way is
 * joined, not restarted, so a second click before the first lands adds none.
 */
function refreshDiff({ account, ref }: Pick<PullRequest, "account" | "ref">): Promise<unknown> {
  return Promise.all(
    [rpc.pullRequest.queryKey({ account, ref }), rpc.changedFiles.queryKey({ account, ref })].map(
      (queryKey) => pluginQueryClient.invalidateQueries({ queryKey }, { cancelRefetch: false }),
    ),
  );
}

// ── The tab ──────────────────────────────────────────────────────────────

export function ChangesTab({ pr }: { pr: PullRequest }) {
  // Filter, folds, and focus belong to one pull request.
  return <PrChanges key={prKey(pr.ref)} pr={pr} />;
}

function PrChanges({ pr }: { pr: PullRequest }) {
  const files = rpc.changedFiles.useQuery(
    { account: pr.account, ref: pr.ref },
    { staleTime: 30_000 },
  );
  const behind = useCatchUp(pr, files.data);
  const marks = usePrMarks(pr);
  return (
    <>
      <SyncState query={files} errorsOnly className="px-3 pt-1" />
      <Changes target={{ pr }} files={files} behind={behind} marks={marks} />
    </>
  );
}

/** An unpublished branch's Changes tab: everything `base..head` changes, read in its checkout. */
export function BranchChangesTab({ branch }: { branch: LocalBranch }) {
  const files = rpc.localChanges.useQuery(
    { hostId: branch.hostId, path: branch.path, base: branch.base, head: branch.head },
    { staleTime: 30_000 },
  );
  const review = useBranchReviewed(branch);
  const marks = useBranchMarks(branch, review);
  if (review.isPending)
    return <Loading label="Loading review progress…" rows={6} className="p-3" />;
  return (
    <>
      <LocalReviewNotices query={review} />
      <Changes
        key={`${branch.id}:${branch.base}:${branch.head}`}
        target={{ branch }}
        files={files}
        behind={false}
        marks={marks}
      />
    </>
  );
}

function Changes({
  target,
  files,
  behind,
  marks,
}: {
  target: ReviewTarget;
  files: UseQueryResult<ChangedFiles, Error>;
  marks: ReviewMarks | null;
  /** The files are still of an older revision than the pull request. */
  behind: boolean;
}) {
  const [revealRequest, releaseReveal] = useClaimedReveal();
  const { pr, noun } = reviewSubject(target);

  if (files.isPending) {
    return <Loading label="Loading changed files…" rows={6} className="p-3" />;
  }
  // A pull request's failed refresh keeps the files last read: they carry
  // their own revision, and the freshness line above says the refresh failed.
  if (files.isLoadingError || (files.isError && !pr)) {
    return (
      <div className="p-3">
        <Notice
          tone="error"
          title="Changed files failed to load"
          action={<RetryButton onRetry={() => void files.refetch()} />}
        >
          {errorText(files.error)}
        </Notice>
      </div>
    );
  }
  if (files.data.files.length === 0) {
    // A push that reverted every file leaves its threads, drafts among them,
    // with no card to show them on.
    return (
      <div className="h-full min-h-0 overflow-y-auto p-3 [scrollbar-gutter:stable]">
        {pr && behind ? <BehindNotice pr={pr} className="mb-2" /> : null}
        <Notice tone="info" title="No changed files">
          {`This ${noun} does not change any files.`}
        </Notice>
        <OrphanThreads pr={pr} groups={[...groupByPath(pr?.threads ?? EMPTY_THREADS)]} />
      </div>
    );
  }
  return (
    <ChangesView
      target={target}
      changed={files.data}
      marks={marks}
      behind={behind}
      revealRequest={revealRequest}
      releaseReveal={releaseReveal}
    />
  );
}

function ChangesView({
  target,
  changed,
  marks,
  behind,
  revealRequest,
  releaseReveal,
}: {
  target: ReviewTarget;
  changed: ChangedFiles;
  marks: ReviewMarks | null;
  /** The files are still of an older revision than the pull request. */
  behind: boolean;
  revealRequest: RevealRequest | null;
  releaseReveal: () => void;
}) {
  const { pr, noun } = reviewSubject(target);
  const activity = useAgentActivity(target);
  const [filter, setFilter] = useState("");
  const [openState, setOpenState] = useState<Readonly<Record<string, boolean>>>({});
  const [focus, setFocus] = useState<Focus | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [railOpen, setRailOpen] = useState(true);
  const [diffStyle, setDiffStyle] = useStoredChoice("diff-style", DIFF_STYLES, "unified");
  const scroller = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const reviewLabel = marks?.label ?? "Reviewed";

  const all = useMemo(
    () => readingOrder(marks ? marks.files(changed.files) : changed.files),
    [changed.files, marks],
  );
  const shown = useMemo(() => all.filter((file) => matches(file, filter)), [all, filter]);
  const shownPaths = useMemo(() => shown.map((file) => file.path), [shown]);
  const threads = pr?.threads ?? EMPTY_THREADS;
  const threadsByPath = useMemo(() => groupByPath(threads), [threads]);
  // Threads on a path no card has: a later push reverted or renamed the file.
  const orphans = useMemo(() => {
    const changedPaths = new Set(all.map((file) => file.path));
    return [...threadsByPath].filter(
      ([path]) => !changedPaths.has(path) && matches({ path, previousPath: null }, filter),
    );
  }, [all, threadsByPath, filter]);
  const review = activity.data?.latestReview ?? null;
  const findingsByPath = useMemo(() => groupByPath(review?.findings ?? []), [review]);
  // A review of another head, or of the same head against another base, saw other lines.
  const findingsStale =
    review !== null &&
    (review.headRefOid !== changed.headRefOid || review.baseRefName !== changed.baseRefName);
  const isOpen = (file: ChangedFile) => openState[file.path] ?? startsOpen(file);
  const anyOpen = shown.some(isOpen);

  const holdFolding = useFoldInPlace(scroller, list);
  const setOpen = useCallback(
    (path: string, open: boolean) => {
      if (!open) holdFolding(path);
      setOpenState((state) => ({ ...state, [path]: open }));
    },
    [holdFolding],
  );
  const onViewedChange = useViewedToggle(marks, setOpen);
  const reveal = useCallback(
    (path: string, line: LineFocus | null) => {
      const file = all.find((each) => each.path === path);
      if (!file) return;
      if (!matches(file, filter)) setFilter("");
      setOpen(path, true);
      setCurrent(path);
      setFocus({ path, line });
    },
    [all, filter, setOpen],
  );
  useRevealRequest(revealRequest, releaseReveal, reveal);
  usePinFocus(scroller, list, focus);
  useCurrentFile(scroller, list, shownPaths, setCurrent);

  return (
    <div className="@container/changes flex h-full min-h-0 min-w-0">
      <FilePanel
        open={railOpen}
        filter={filter}
        onFilter={setFilter}
        files={shown}
        total={all.length}
        current={current}
        threadsByPath={threadsByPath}
        onSelect={reveal}
        onViewedChange={onViewedChange}
        reviewLabel={reviewLabel}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Toolbar
          railOpen={railOpen}
          onToggleRail={() => setRailOpen((open) => !open)}
          viewed={marks ? all.filter((file) => file.viewed === "viewed").length : null}
          reviewLabel={reviewLabel}
          fresh={!marks?.loadError}
          total={all.length}
          findingsStale={findingsStale}
          diffStyle={diffStyle}
          onDiffStyle={setDiffStyle}
          anyOpen={anyOpen}
          onToggleAll={
            shown.length === 0
              ? null
              : () =>
                  setOpenState((state) => ({
                    ...state,
                    ...Object.fromEntries(shownPaths.map((path) => [path, !anyOpen])),
                  }))
          }
        />
        <PullRequestNotices pr={pr} behind={behind} />
        {marks ? <ViewedErrors pull={marks.errorKey} /> : null}
        <div
          ref={scroller}
          data-cr-scroll
          className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
        >
          <div ref={list} className="flex flex-col gap-2 p-2 pb-8">
            <MatchesNotice count={shown.length} noun={noun} filter={filter} />
            {shown.map((file) => (
              <DiffFile
                key={file.path}
                pr={pr}
                file={file}
                headRefOid={changed.headRefOid}
                baseRefName={changed.baseRefName}
                threads={threadsByPath.get(file.path) ?? EMPTY_THREADS}
                findings={findingsByPath.get(file.path) ?? EMPTY_FINDINGS}
                findingsStale={findingsStale}
                open={isOpen(file)}
                diffStyle={diffStyle}
                focus={focus?.path === file.path ? focus.line : null}
                onOpenChange={setOpen}
                onViewedChange={onViewedChange}
                reviewLabel={reviewLabel}
              />
            ))}
            <OrphanThreads pr={pr} groups={orphans} />
          </div>
        </div>
      </div>
    </div>
  );
}

function MatchesNotice({ count, noun, filter }: { count: number; noun: string; filter: string }) {
  if (count > 0) return null;
  return (
    <Notice
      tone="info"
      title="No files match"
    >{`Nothing in this ${noun} matches “${filter.trim()}”.`}</Notice>
  );
}

function LocalReviewNotices({ query }: { query: ReturnType<typeof useBranchReviewed> }) {
  if (!query.isError) return null;
  return (
    <div className="p-2">
      <Notice
        tone="error"
        title="Review progress could not load"
        action={<RetryButton onRetry={() => void query.refetch()} />}
      >
        {errorText(query.error)}
      </Notice>
    </div>
  );
}

/** Offers a fresh read after every attempt to catch up to the PR failed. */
function BehindNotice({ pr, className }: { pr: PullRequest; className?: string }) {
  return (
    <Notice
      tone="info"
      title="The diff is behind the pull request"
      className={className}
      action={
        <Button
          variant="outline"
          size="sm"
          className="h-6 px-2.5 text-xs font-normal"
          onClick={() => void refreshDiff(pr)}
        >
          Refresh
        </Button>
      }
    >
      GitHub still sends the files from before the latest push or base change, so new comments on
      them would not be saved.
    </Notice>
  );
}

/** Above a pull request's diffs: that they lag it, and why Viewed boxes went back. */
function PullRequestNotices({ pr, behind }: { pr: PullRequest | null; behind: boolean }) {
  if (!pr) return null;
  return (
    <>
      {behind ? (
        <div className="shrink-0 px-2 pt-2">
          <BehindNotice pr={pr} />
        </div>
      ) : null}
    </>
  );
}

/** Why each Viewed box went back, until dismissed or the file's next write lands. */
function ViewedErrors({ pull }: { pull: string }) {
  const errors = useViewedErrors(pull);
  if (!errors) return null;
  return (
    <div className="shrink-0 px-2 pt-2">
      <Notice
        tone="error"
        action={
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2.5 text-xs font-normal"
            onClick={() => dismissViewedErrors(pull)}
          >
            Dismiss
          </Button>
        }
      >
        {[...errors].map(([path, error]) => (
          <p key={path}>{error}</p>
        ))}
      </Notice>
    </div>
  );
}

/** The left column: the filter, then the file list. Wide panes only. */
function FilePanel({
  open,
  filter,
  onFilter,
  files,
  total,
  ...rail
}: {
  open: boolean;
  filter: string;
  onFilter: (filter: string) => void;
  files: readonly ChangedFile[];
  total: number;
  reviewLabel: string;
  current: string | null;
  threadsByPath: ReadonlyMap<string, readonly ReviewThread[]>;
  onSelect: (path: string, line: null) => void;
  onViewedChange: ((file: ChangedFile, viewed: boolean) => void) | null;
}) {
  return (
    <nav
      aria-label="Changed files"
      className={cn(
        "hidden w-64 shrink-0 flex-col border-r border-border",
        open && "@3xl/changes:flex",
      )}
    >
      <div className="flex flex-col gap-1.5 border-b border-border p-2">
        <Input
          type="search"
          value={filter}
          onChange={(event) => onFilter(event.target.value)}
          placeholder="Filter files"
          aria-label="Filter changed files"
          className="h-7 text-xs"
        />
        {filter.trim() ? (
          <p className="px-0.5 text-[11px] text-muted-foreground" aria-live="polite">
            {files.length} of {plural(total, "file")}
          </p>
        ) : null}
      </div>
      <FileRail files={files} {...rail} />
    </nav>
  );
}

/** Above the diffs: the file list's toggle, progress (or the file count), layout, and fold-all. */
function Toolbar({
  railOpen,
  onToggleRail,
  viewed,
  total,
  findingsStale,
  diffStyle,
  onDiffStyle,
  anyOpen,
  onToggleAll,
  reviewLabel,
  fresh,
}: {
  railOpen: boolean;
  onToggleRail: () => void;
  /** Null until review marks are available. */
  viewed: number | null;
  total: number;
  findingsStale: boolean;
  diffStyle: DiffStyle;
  onDiffStyle: (style: DiffStyle) => void;
  anyOpen: boolean;
  /** Null when no file is shown to fold or open. */
  onToggleAll: (() => void) | null;
  reviewLabel: string;
  fresh: boolean;
}) {
  return (
    <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-2 py-1">
      {/* The list only fits a wide pane, so its toggle shows only there. */}
      <button
        type="button"
        className={cn(
          "hidden size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground @3xl/changes:inline-flex",
          CONTROL_HOVER_TRANSITION,
        )}
        aria-label={railOpen ? "Hide file list" : "Show file list"}
        aria-pressed={railOpen}
        onClick={onToggleRail}
      >
        <Icon name="PanelLeft" className="size-3.5" aria-hidden />
      </button>
      {viewed === null ? (
        <span className="tabular-nums">{plural(total, "file")}</span>
      ) : (
        <span className="flex items-center gap-2 tabular-nums">
          <span>
            {viewed} of {plural(total, "file")} {reviewLabel.toLowerCase()}
          </span>
          {fresh && viewed === total && total > 0 ? (
            <span className="text-success">Ready</span>
          ) : null}
          <span aria-hidden className="h-1 w-20 overflow-hidden rounded-full bg-secondary">
            <span
              className="block h-full rounded-full bg-success transition-[width] duration-200 motion-reduce:transition-none"
              style={{ width: `${(viewed / total) * 100}%` }}
            />
          </span>
        </span>
      )}
      {findingsStale ? (
        <span className="text-[11px] text-warning-text">
          bb findings are from an older version of this diff
        </span>
      ) : null}
      <span className="ml-auto flex items-center gap-1.5">
        <fieldset className="inline-flex h-6 items-center rounded-md bg-secondary p-0.5">
          <legend className="sr-only">Diff layout</legend>
          {DIFF_STYLES.map((style) => (
            <button
              key={style}
              type="button"
              aria-pressed={diffStyle === style}
              className={cn(
                "h-5 cursor-pointer rounded-[4px] px-2 text-[11px] text-muted-foreground hover:text-foreground",
                diffStyle === style && "bg-background text-foreground shadow-xs",
                CONTROL_HOVER_TRANSITION,
              )}
              onClick={() => onDiffStyle(style)}
            >
              {style === "unified" ? "Unified" : "Split"}
            </button>
          ))}
        </fieldset>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs font-normal"
          disabled={!onToggleAll}
          onClick={onToggleAll ?? undefined}
        >
          {anyOpen ? "Collapse all" : "Expand all"}
        </Button>
      </span>
    </div>
  );
}

/**
 * Threads on files no longer in the diff, below the cards, one group per
 * path. No card would show them, and a draft among them still goes out with
 * the review, so it stays here to edit or delete.
 */
function OrphanThreads({
  pr,
  groups,
}: {
  /** None for an unpublished branch, which has no threads. */
  pr: PullRequest | null;
  groups: readonly (readonly [string, readonly ReviewThread[]])[];
}) {
  const headingId = useId();
  if (!pr || groups.length === 0) return null;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2 pt-2">
      <h3 id={headingId} className="px-0.5 font-medium text-muted-foreground">
        Comments on files no longer in the diff
      </h3>
      {groups.map(([path, threads]) => (
        <section
          key={path}
          aria-label={path}
          className="overflow-clip rounded-md border border-border bg-card"
        >
          <h4 className="flex min-h-9 min-w-0 items-center border-b border-border px-3 py-1">
            <span
              dir="rtl"
              className="min-w-0 truncate font-mono text-xs font-medium"
              title={path}
              translate="no"
            >
              {`‎${path}`}
            </span>
          </h4>
          <div className="flex flex-col gap-2 p-2">
            {threads.map((thread) => (
              <ReviewThreadView key={thread.id} pr={pr} thread={thread} showContext />
            ))}
          </div>
        </section>
      ))}
    </section>
  );
}

// ── File list ────────────────────────────────────────────────────────────

/** Up and Down walk the rows, so a long list is not a hundred Tab presses. */
function walkRows(event: KeyboardEvent<HTMLButtonElement>): void {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const list = event.currentTarget.closest("ul");
  if (!list) return;
  const rows = [...list.querySelectorAll<HTMLElement>("[data-rail-path]")];
  const index = rows.indexOf(event.currentTarget);
  event.preventDefault();
  rows[
    Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))
  ]?.focus();
}

/**
 * Every shown file: its Viewed box (on a pull request), name, comment count,
 * and line counts. A row scrolls the diff to its file, and the current
 * file's row stays in view.
 */
function FileRail({
  files,
  reviewLabel,
  current,
  threadsByPath,
  onSelect,
  onViewedChange,
}: {
  files: readonly ChangedFile[];
  reviewLabel: string;
  current: string | null;
  threadsByPath: ReadonlyMap<string, readonly ReviewThread[]>;
  onSelect: (path: string, line: null) => void;
  onViewedChange: ((file: ChangedFile, viewed: boolean) => void) | null;
}) {
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const container = list.current;
    if (!container || !current) return;
    for (const row of container.querySelectorAll<HTMLElement>("[data-rail-path]")) {
      if (row.dataset.railPath === current) keepInView(container, row);
    }
  }, [current]);
  return (
    <ul ref={list} className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto p-1.5">
      {files.map((file) => {
        const slash = file.path.lastIndexOf("/");
        const name = file.path.slice(slash + 1);
        const folder = slash === -1 ? "" : file.path.slice(0, slash);
        const threads = threadsByPath.get(file.path)?.length ?? 0;
        const viewed = file.viewed === "viewed";
        const isCurrent = file.path === current;
        return (
          <li
            key={file.path}
            className={cn(
              "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-1.5 hover:bg-state-hover",
              isCurrent && "bg-surface-selected hover:bg-surface-selected",
            )}
          >
            {onViewedChange ? (
              <input
                type="checkbox"
                className="size-3.5 shrink-0 cursor-pointer accent-primary"
                checked={viewed}
                aria-label={`${reviewLabel} ${file.path}`}
                onChange={(event) => onViewedChange(file, event.target.checked)}
              />
            ) : null}
            <button
              type="button"
              data-rail-path={file.path}
              className="flex min-w-0 flex-1 cursor-pointer items-baseline gap-1.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm"
              title={file.path}
              aria-current={isCurrent ? "location" : undefined}
              onClick={() => onSelect(file.path, null)}
              onKeyDown={walkRows}
            >
              <span
                className={cn(
                  "max-w-full shrink-0 truncate font-medium",
                  viewed && "text-muted-foreground",
                )}
                translate="no"
              >
                {name}
              </span>
              {folder ? (
                <span
                  dir="rtl"
                  className="min-w-0 truncate text-[11px] text-subtle-foreground"
                  translate="no"
                >
                  {`\u200e${folder}`}
                </span>
              ) : null}
            </button>
            {threads > 0 ? (
              <span
                className="inline-flex shrink-0 items-center gap-0.5 text-[11px] text-muted-foreground tabular-nums"
                title={plural(threads, "comment thread")}
              >
                <Icon name="MessageSquare" className="size-3" aria-hidden />
                {threads}
                <span className="sr-only"> comment threads</span>
              </span>
            ) : null}
            <span className="shrink-0 text-[11px] tabular-nums">
              <span className="text-diff-added">+{file.additions}</span>{" "}
              <span className="text-diff-removed">−{file.deletions}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
