import {
  definePluginApp,
  experimental_Icon as Icon,
  experimental_ProviderIcon as ProviderIcon,
  experimental_usePluginId,
  experimental_useProviders,
  type PluginBrowserBbSdk,
  type PluginThreadHeaderActionProps,
  useBbNavigate,
  useComposerView,
  useRealtimeConnectionState,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import { useEffect, useState } from "react";

const RUNNING = new Set(["pending", "starting", "active", "stopping"]);
// Reviews can be created, moved between parents, completed, or removed.
const RELEVANT_CHANGES = new Set([
  "thread-created",
  "parent-changed",
  "status-changed",
  "archived-changed",
  "thread-deleted",
]);

type RunDisplay = {
  mode: "quick" | "standard" | "deep";
  kind: "design" | "implementation";
  startedAt: number;
  status: string;
};
type Review = Pick<
  Awaited<ReturnType<PluginBrowserBbSdk["threads"]["get"]>>,
  "id" | "providerId" | "status" | "createdAt"
> & { run?: RunDisplay };
type ReviewParent = { threadId: string; isReview: boolean; parentThreadId: string | null };

// This graph only reserves space. Buttons always use fresh SDK responses.
// Separate review membership from parent membership: an archived review keeps
// its Back row, while its author only reserves space for unarchived reviews.
// Changes missed while all thread surfaces are unmounted are reconciled on
// the next lookup, which can release a stale reservation once on that visit.
class ReviewLayout {
  private readonly reviewParents = new Map<string, string>();
  private readonly parentReviews = new Map<string, Set<string>>();

  has(threadId: string) {
    return this.reviewParents.has(threadId) || (this.parentReviews.get(threadId)?.size ?? 0) > 0;
  }

  invalidateReview(reviewId: string) {
    const parent = this.reviewParents.get(reviewId);
    const children = parent ? this.parentReviews.get(parent) : undefined;
    children?.delete(reviewId);
    if (parent && children?.size === 0) this.parentReviews.delete(parent);
  }

  forgetReview(reviewId: string) {
    this.invalidateReview(reviewId);
    this.reviewParents.delete(reviewId);
  }

  recordReview(reviewId: string, parentId: string | null, archived: boolean) {
    this.forgetReview(reviewId);
    if (!parentId) return;
    this.reviewParents.set(reviewId, parentId);
    if (archived) return;
    let children = this.parentReviews.get(parentId);
    if (!children) {
      children = new Set();
      this.parentReviews.set(parentId, children);
    }
    children.add(reviewId);
  }

  recordChildren(parentId: string, children: readonly { id: string }[]) {
    this.parentReviews.delete(parentId);
    for (const child of children) this.recordReview(child.id, parentId, false);
  }
}

const layouts = new WeakMap<PluginBrowserBbSdk, ReviewLayout>();
function knownLayout(sdk: PluginBrowserBbSdk) {
  let layout = layouts.get(sdk);
  if (!layout) {
    layout = new ReviewLayout();
    layouts.set(sdk, layout);
  }
  return layout;
}

/** Keep finished reviews available so navigation survives completion. */
function useReviews(threadId: string): Review[] | null {
  const sdk = useSdk();
  const pluginId = experimental_usePluginId();
  const connection = useRealtimeConnectionState();
  const [reviews, setReviews] = useState<Review[] | null>(null);

  // oxlint-disable-next-line react-doctor/effect-needs-cleanup -- The nested retry timer is cleared in this effect's cleanup, verified by the unmount test.
  useEffect(() => {
    let known = new Set<string>();
    let latest = 0;
    let pending = 0;
    let discovered = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = 1000;
    let poll: ReturnType<typeof setTimeout> | undefined;
    let pollDelay = 3000;
    const refresh = async () => {
      clearTimeout(retry);
      retry = undefined;
      const request = ++latest;
      pending += 1;
      let children;
      try {
        children = await sdk.threads.list({
          parentThreadId: threadId,
          originPluginId: pluginId,
          includeHidden: true,
          archived: false,
        });
      } catch {
        if (request === latest) {
          discovered = false;
          retry = setTimeout(() => void refresh(), retryDelay);
          retryDelay = Math.min(retryDelay * 2, 10000);
        }
        return;
      } finally {
        pending -= 1;
      }
      const withRuns = await Promise.all(
        children.map(async (child) => {
          try {
            const metadata = await sdk.threads.getPluginMetadata({ threadId: child.id, pluginId });
            const run = metadata.reviewRun as RunDisplay | undefined;
            return {
              ...child,
              run:
                run &&
                typeof run.startedAt === "number" &&
                ["quick", "standard", "deep"].includes(run.mode) &&
                ["design", "implementation"].includes(run.kind)
                  ? run
                  : undefined,
            };
          } catch {
            return { ...child, run: undefined };
          }
        }),
      );
      // A slower, older response must not overwrite a newer one.
      if (request !== latest) return;
      retryDelay = 1000;
      discovered = true;
      known = new Set(children.map((child) => child.id));
      knownLayout(sdk).recordChildren(threadId, children);
      clearTimeout(poll);
      if (
        withRuns.some(
          (child) =>
            !RUNNING.has(child.status) &&
            (child.run?.status === "running" || child.run?.status === "starting"),
        )
      ) {
        poll = setTimeout(() => void refresh(), pollDelay);
        pollDelay = Math.min(pollDelay * 2, 30000);
      } else pollDelay = 3000;
      setReviews(
        withRuns
          .sort((a, b) => (b.run?.startedAt ?? b.createdAt) - (a.run?.startedAt ?? a.createdAt))
          .map(({ id, providerId, status, createdAt, run }) => ({
            id,
            providerId,
            status,
            createdAt,
            run,
          })),
      );
    };
    const unsubscribe = sdk.subscribe({
      event: "thread:changed",
      callback: (event) => {
        const created = event.changes.includes("thread-created");
        const reparented = event.changes.includes("parent-changed");
        if (event.id && event.changes.includes("thread-deleted")) {
          knownLayout(sdk).forgetReview(event.id);
        } else if (event.id && (reparented || event.changes.includes("archived-changed"))) {
          knownLayout(sdk).invalidateReview(event.id);
        }
        const ours = event.id !== undefined && known.has(event.id);
        // A child can finish before its discovery response establishes membership.
        if (
          (created || reparented || ours || pending > 0 || !discovered) &&
          event.changes.some((change) => RELEVANT_CHANGES.has(change))
        ) {
          pollDelay = 3000;
          void refresh();
        }
      },
    });
    void refresh();
    return () => {
      latest = -1;
      clearTimeout(retry);
      clearTimeout(poll);
      unsubscribe();
    };
  }, [sdk, pluginId, threadId, connection]);

  return reviews;
}

// Each review state reads at a glance: what is happening, and how it went.
const PHASES = {
  running: { icon: "Spinner", tone: "text-muted-foreground animate-spin", status: "Running" },
  complete: { icon: "CircleCheck", tone: "text-success", status: "Done" },
  failed: { icon: "AlertCircle", tone: "text-destructive", status: "Failed" },
  awaiting: { icon: "Clock", tone: "text-muted-foreground", status: "Awaiting result" },
  incomplete: { icon: "AlertCircle", tone: "text-muted-foreground", status: "Incomplete" },
} as const;

type Navigation =
  | { back: true; target: string; label: string }
  | {
      back: false;
      target: string;
      label: string;
      phase: keyof typeof PHASES;
      running: number;
      startedAt: number;
      providerId: string;
      title: string;
    };

function reviewPhase(review: Review): keyof typeof PHASES {
  if (review.status === "error" || review.run?.status === "failed") return "failed";
  if (review.run?.status === "incomplete") return "incomplete";
  if (review.run?.status === "running" || review.run?.status === "starting") return "awaiting";
  return "complete";
}

/** Select one navigation target before rendering either direction in the same row. */
function reviewNavigation(parent: ReviewParent, reviews: Review[] | null): Navigation | null {
  if (parent.isReview) {
    return parent.parentThreadId
      ? { back: true, target: parent.parentThreadId, label: "Back to main thread" }
      : null;
  }
  const running = reviews?.filter((review) => RUNNING.has(review.status)) ?? [];
  const review = running[0] ?? reviews?.[0];
  if (!review) return null;
  const phase = running.length > 0 ? "running" : reviewPhase(review);
  const title = review.run
    ? `${review.run.mode[0]!.toUpperCase()}${review.run.mode.slice(1)} ${review.run.kind} review`
    : "Adversarial review";
  const label =
    running.length > 1 ? `${running.length} adversarial reviews running` : `${title} ${phase}`;
  return {
    back: false,
    target: review.id,
    label,
    phase,
    running: running.length,
    startedAt: review.run?.startedAt ?? review.createdAt,
    providerId: review.providerId,
    title,
  };
}

function formatElapsed(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** Ticks once a second so a running review shows that it is still alive. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <span className="tabular-nums">{formatElapsed(now - since)}</span>;
}

function Reviewer({ providerId }: { providerId: string }) {
  const { providers } = experimental_useProviders();
  const provider = providers.find((candidate) => candidate.id === providerId);
  return (
    <span className="hidden min-w-0 shrink items-center gap-1 text-muted-foreground @sm:flex">
      <ProviderIcon
        providerKind="agent"
        provider={provider ?? { id: providerId }}
        className="size-3.5 shrink-0"
        aria-hidden
      />
      <span className="truncate">{provider?.displayName ?? providerId}</span>
    </span>
  );
}

const ROW =
  "group @container flex h-8 w-full rounded-[calc(var(--radius-lg)-1px)] min-w-0 shrink-0 cursor-pointer items-center gap-2 px-3 text-xs transition-colors hover:bg-background/80";

function ReviewRow({ threadId }: { threadId: string }) {
  const sdk = useSdk();
  const parent = useReviewParent(threadId);
  const reviews = useReviews(threadId);
  const navigate = useBbNavigate();
  // Reserve the same row during both lookups, including a fresh route mount.
  // Switching between linked threads must never collapse the composer banner.
  if (parent === null || (!parent.isReview && reviews === null)) {
    return knownLayout(sdk).has(threadId) ? (
      <div data-review-navigation className="h-8 w-full shrink-0" aria-hidden />
    ) : null;
  }
  const navigation = reviewNavigation(parent, reviews);
  if (!navigation) return null;
  const open = () => navigate.toThread(navigation.target);

  if (navigation.back) {
    return (
      <button
        type="button"
        data-review-navigation
        onClick={open}
        aria-label={navigation.label}
        className={`${ROW} text-muted-foreground hover:text-foreground`}
      >
        <Icon name="ArrowLeft" className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-left font-medium">{navigation.label}</span>
      </button>
    );
  }

  const phase = PHASES[navigation.phase];
  const running = navigation.phase === "running";
  return (
    <button
      type="button"
      data-review-navigation
      data-review-phase={navigation.phase}
      onClick={open}
      aria-label={`${navigation.label}. Open the review thread.`}
      className={`${ROW} text-foreground`}
    >
      <Icon name={phase.icon} className={`size-3.5 shrink-0 ${phase.tone}`} aria-hidden />
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5 text-left">
        <span className={`${running ? "animate-shine " : ""}min-w-0 truncate font-medium`}>
          {navigation.title}
        </span>
        <span
          className={`shrink-0 whitespace-nowrap ${running ? "text-muted-foreground" : phase.tone}`}
        >
          {navigation.running > 1 ? `${navigation.running} running` : phase.status}
          {running && navigation.running === 1 && (
            <>
              {" · "}
              <Elapsed since={navigation.startedAt} />
            </>
          )}
        </span>
      </span>
      <Reviewer providerId={navigation.providerId} />
      <span className="flex shrink-0 items-center text-muted-foreground transition-colors group-hover:text-foreground">
        Open
        <Icon name="ChevronRight" className="size-3.5" aria-hidden />
      </span>
    </button>
  );
}

function ReviewBanner() {
  const { scope } = useComposerView();
  return scope.kind === "thread" ? (
    <ReviewRow key={scope.threadId} threadId={scope.threadId} />
  ) : null;
}

function useReviewParent(threadId: string) {
  const sdk = useSdk();
  const pluginId = experimental_usePluginId();
  const connection = useRealtimeConnectionState();
  const [target, setTarget] = useState<ReviewParent | null>(null);

  // Fetch over HTTP immediately in every connection state. Reconnecting can
  // miss a parent-change event, so refresh without waiting for the socket.
  // oxlint-disable-next-line react-doctor/effect-needs-cleanup -- The retry timer is cleared on unmount, verified by the header lookup cleanup test.
  useEffect(() => {
    let cancelled = false;
    let latest = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = 1000;
    const load = async () => {
      clearTimeout(retry);
      retry = undefined;
      const request = ++latest;
      try {
        // The sidebar roster omits hidden reviews on current bb hosts.
        const thread = await sdk.threads.get({ threadId });
        if (!cancelled && request === latest) {
          retryDelay = 1000;
          knownLayout(sdk).recordReview(
            threadId,
            thread.originPluginId === pluginId ? thread.parentThreadId : null,
            thread.archivedAt !== null,
          );
          setTarget({
            threadId,
            isReview: thread.originPluginId === pluginId,
            parentThreadId: thread.originPluginId === pluginId ? thread.parentThreadId : null,
          });
        }
      } catch {
        if (!cancelled && request === latest) {
          retry = setTimeout(() => void load(), retryDelay);
          retryDelay = Math.min(retryDelay * 2, 10000);
        }
      }
    };
    const unsubscribe = sdk.subscribe({
      event: "thread:changed",
      callback: (event) => {
        if (event.id === threadId && event.changes.includes("thread-deleted")) {
          latest += 1;
          clearTimeout(retry);
          knownLayout(sdk).forgetReview(threadId);
          setTarget({ threadId, isReview: false, parentThreadId: null });
          return;
        }
        if (
          event.id === threadId &&
          (event.changes.includes("parent-changed") || event.changes.includes("archived-changed"))
        ) {
          knownLayout(sdk).invalidateReview(threadId);
          if (event.changes.includes("parent-changed")) setTarget(null);
          void load();
        }
      },
    });
    void load();
    return () => {
      cancelled = true;
      clearTimeout(retry);
      unsubscribe();
    };
  }, [sdk, pluginId, threadId, connection]);

  return target?.threadId === threadId ? target : null;
}

function BackToMainThread({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const target = useReviewParent(threadId);
  const navigate = useBbNavigate();
  const parentThreadId = target?.parentThreadId;
  if (!parentThreadId) return null;

  return (
    <button
      type="button"
      onClick={() => navigate.toThread(parentThreadId)}
      aria-label="Back to main thread"
      title="Back to main thread"
      className="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      <Icon name="ArrowLeft" className="size-3.5 shrink-0" aria-hidden />
      {!isCompactViewport && <span>Back to main thread</span>}
    </button>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadHeaderAction({
    id: "back-to-main-thread",
    title: "Review navigation",
    component: BackToMainThread,
  });
  app.composer.customize({
    id: "review",
    scopes: ["thread"],
    banners: [{ id: "running-review", component: ReviewBanner }],
  });
});
