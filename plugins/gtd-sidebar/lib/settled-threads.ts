/**
 * The Settled shelf's own thread rows.
 *
 * Settling is bb's archive, and the host's sidebar view is built from queries
 * pinned to `archived: false` — an archived thread is evicted from that cache,
 * so `experimental_useSidebarThreads` can never report it, and `isArchived`
 * on a reported thread is always false.
 *
 * So the plugin fetches bb's archived threads through its backend and maps
 * them into the shape the rest of the list already speaks. These functions are
 * that mapping, kept pure so they can be tested without a bb server.
 */
import type { PluginSidebarThread, PluginSidebarThreadIndicator } from "@get-bb/plugin-sdk";

/**
 * How far back the Settled shelf reaches.
 *
 * A shelf that keeps everything ever archived is bb's archive with extra steps
 * — it grows without bound and buries the one thing the shelf is for: undoing
 * a settle you regret. A day covers "I filed that this morning" and keeps the
 * shelf readable.
 *
 * Nothing is unarchived when a thread ages out. It stops being drawn here and
 * stays exactly where it is, in bb's archived view.
 */
export const SETTLED_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Whether an archive is recent enough to still be drawn on the shelf. */
export function isWithinSettledWindow(
  settledAt: number,
  now: number,
  windowMs: number = SETTLED_WINDOW_MS,
): boolean {
  // A stamp in the future — a clock that moved — is kept rather than hidden.
  // Losing a row the user just made would be the worse failure.
  return settledAt > now - windowMs;
}

/** One archived thread as the plugin's backend reports it. */
export interface SettledThreadRow {
  id: string;
  /** bb's `archivedAt`. The shelf's window is measured on this. */
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
 * The glyph a settled row draws. Almost always "none" — a thread is archived
 * once its work is done — but mapped faithfully so an archived thread that is
 * somehow still working or asking says so on its row.
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
 * `environment` and `host` are null: the Settled shelf draws one line — title,
 * glyph, time — and nothing on it reads a branch or a machine.
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
    // The one field the host would never report as true, and the reason this
    // whole path exists. The inbox shelves on it.
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
 * The host's threads plus the settled ones it cannot see.
 *
 * The host wins every collision. Its view is live and this one is a round trip
 * old, so a thread bb has already unarchived — an un-settle that landed while
 * the fetch was in flight — must not be dragged back to the shelf by a stale
 * copy of itself.
 */
export function mergeSettledThreads(
  hostThreads: readonly PluginSidebarThread[],
  settledThreads: readonly PluginSidebarThread[],
): PluginSidebarThread[] {
  if (settledThreads.length === 0) return [...hostThreads];
  const hostIds = new Set(hostThreads.map((thread) => thread.id));
  return [...hostThreads, ...settledThreads.filter((thread) => !hostIds.has(thread.id))];
}
