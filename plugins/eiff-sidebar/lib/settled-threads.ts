/**
 * The settled shelf's own thread rows.
 *
 * Current settled threads stay unarchived and arrive in the host's sidebar
 * list. Older builds archived them, so the plugin still fetches those legacy
 * rows through its backend and maps them into the shape the list already
 * speaks. These functions are kept pure so they can be tested without a bb
 * server.
 */
import type { PluginSidebarThread, PluginSidebarThreadIndicator } from "@get-bb/plugin-sdk";
import type { ThreadLifecycleRow } from "@/lib/lifecycle";

/** One legacy archived, settled thread as the plugin's backend reports it. */
export interface SettledThreadRow {
  id: string;
  /** When this plugin settled it. */
  settledAt: number;
  projectId: string;
  title: string | null;
  titleFallback: string | null;
  parentThreadId: string | null;
  sectionId: string | null;
  /** bb's `originKind`; anything this sidebar does not draw becomes null. */
  originKind: string | null;
  originPluginId: string | null;
  providerId: string;
  /** bb's thread status: "active", "starting", "stopping", "idle", "error". */
  status: string;
  hasPendingInteraction: boolean;
  isPinned: boolean;
  activity: {
    workflows: number;
    backgroundAgents: number;
    backgroundCommands: number;
    planMode: number;
    goals: number;
  };
  createdAt: number;
  updatedAt: number;
  lastReadAt: number | null;
  latestAttentionAt: number;
}

/** bb's own rule: read means the last read caught up with the last attention. */
export function isUnread(row: SettledThreadRow): boolean {
  return (row.lastReadAt ?? 0) < row.latestAttentionAt;
}

function isWorkingStatus(status: string): boolean {
  return status === "active" || status === "starting" || status === "stopping";
}

/**
 * The glyph a settled row would draw.
 *
 * Almost always "none": live work and a raised hand un-settle a thread, so a
 * row that is still settled is a quiet one. It is mapped faithfully anyway,
 * because it is also what `resolveShelf` reads to decide the thread has come
 * back — a row that reported itself quiet while it worked would stay parked.
 */
export function settledIndicator(row: SettledThreadRow): {
  indicator: PluginSidebarThreadIndicator;
  indicatorLabel: string | null;
} {
  if (row.hasPendingInteraction) {
    return {
      indicator: "waiting-for-input",
      indicatorLabel: "Thread needs user input",
    };
  }
  const { activity } = row;
  const hasLiveWork =
    activity.workflows > 0 ||
    activity.backgroundAgents > 0 ||
    activity.backgroundCommands > 0 ||
    activity.planMode > 0 ||
    activity.goals > 0;
  if (hasLiveWork || isWorkingStatus(row.status)) {
    return { indicator: "runtime", indicatorLabel: "Thread is working" };
  }
  if (isUnread(row)) {
    return row.status === "error"
      ? {
          indicator: "unread-error",
          indicatorLabel: "Thread ended with an error",
        }
      : {
          indicator: "unread-success",
          indicatorLabel: "Thread has unread activity",
        };
  }
  return { indicator: "none", indicatorLabel: null };
}

/** Only the one kind this sidebar draws a parent chip for survives. */
function originKindFor(value: string | null): "fork" | null {
  return value === "fork" ? value : null;
}

/**
 * A settled row as a sidebar thread.
 *
 * `environment` and `host` are null: the settled shelf draws one line — title,
 * glyph, time — and nothing on it reads a branch or a machine. Inventing them
 * from a second lookup would buy pixels nobody renders.
 */
export function toSidebarThread(row: SettledThreadRow): PluginSidebarThread {
  const { indicator, indicatorLabel } = settledIndicator(row);
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    titleFallback: row.titleFallback,
    parentThreadId: row.parentThreadId,
    sectionId: row.sectionId,
    originKind: originKindFor(row.originKind),
    originPluginId: row.originPluginId,
    providerId: row.providerId,
    hasPendingInteraction: row.hasPendingInteraction,
    activity: row.activity,
    indicator,
    indicatorLabel,
    isUnread: isUnread(row),
    isPinned: row.isPinned,
    // Legacy rows come from bb's archived list, which is why this path exists.
    isArchived: true,
    environment: null,
    host: null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastReadAt: row.lastReadAt,
    latestAttentionAt: row.latestAttentionAt,
  };
}

/**
 * The host's threads plus legacy settled ones it cannot see.
 *
 * The host wins every collision. Its view is live and this one is a round trip
 * old. It can also contain a thread now present in the host list during a
 * restore race. The host wins either collision, so one thread is never drawn
 * or counted twice.
 */
export function mergeSettledThreads(
  hostThreads: readonly PluginSidebarThread[],
  settledThreads: readonly PluginSidebarThread[],
): PluginSidebarThread[] {
  if (settledThreads.length === 0) return [...hostThreads];
  const hostIds = new Set(hostThreads.map((thread) => thread.id));
  return [...hostThreads, ...settledThreads.filter((thread) => !hostIds.has(thread.id))];
}

/**
 * How many settled threads the merge above has not been handed yet.
 *
 * `listSettledThreads` is the only source for legacy rows that bb still has
 * archived, and it is a round trip behind on every mount. Lifecycle rows arrive
 * sooner and name those same threads, so this count keeps the collapsed shelf
 * visible until the legacy fetch resolves.
 *
 * `visibleThreadIds` is the merged list, and subtracting it is what keeps this
 * from counting a thread twice. Current settled threads remain in the host
 * list and already reach the shelf through `resolveShelf`. What is left is the
 * set of legacy archived rows whose absence would empty the shelf.
 *
 * It errs high and never low, which is the direction that matters: the caller
 * adds this to the total that decides whether to draw "No threads yet", and a
 * user whose threads are all settled must never be told they have none. Erring
 * high is not free, so the caller asks for this only while `listSettledThreads`
 * still owes it an answer.
 *
 * One is a row the read cannot resolve: a thread deleted while the plugin was
 * stopped, with no `thread.deleted` to clear the row, or one sitting past the
 * backend's archived-listing cap. It costs a line until the read answers, and
 * the answer is what retires it. Counted past that it would cost far more than a
 * line — a user whose one remaining row is that ghost would have a total of one,
 * so "No threads yet" would never be reached at all and a header that expands to
 * nothing would stand in its place until the next successful read.
 *
 * The other is a row the list will re-classify once the thread arrives, and
 * nothing on the first frame could know better. A legacy archived thread that
 * took a turn comes back to the Inbox once the fetch supplies its signals.
 */
export function pendingSettledCount(
  rows: Iterable<ThreadLifecycleRow>,
  visibleThreadIds: ReadonlySet<string>,
): number {
  let pending = 0;
  for (const row of rows) {
    if (row.settledAt === null) continue;
    if (visibleThreadIds.has(row.threadId)) continue;
    pending += 1;
  }
  return pending;
}
