import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import type { Initiative, InitiativeWorkspace } from "./initiative-types.ts";
import type {
  InitiativeSubscription,
  SubscriptionScheduleConfig,
} from "./initiative-subscriptions.ts";

/** coordinatorThreadId -> Initiative, for O(1) coordinator lookups. */
export function initiativesByCoordinator(
  initiatives: readonly Initiative[],
): Map<string, Initiative> {
  return new Map(initiatives.map((initiative) => [initiative.coordinatorThreadId, initiative]));
}

/** parentThreadId -> direct children, spawn-ordered (createdAt, id). */
export function childrenByParentId(
  threads: readonly PluginSidebarThread[],
): Map<string, PluginSidebarThread[]> {
  const sorted = [...threads].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const map = new Map<string, PluginSidebarThread[]>();
  for (const thread of sorted) {
    if (thread.parentThreadId === null) continue;
    const siblings = map.get(thread.parentThreadId);
    if (siblings === undefined) map.set(thread.parentThreadId, [thread]);
    else siblings.push(thread);
  }
  return map;
}

/**
 * The threads the Projects rail owns: every coordinator plus every thread
 * descended from one. Uses the raw `parentThreadId` chain on purpose — a
 * fork of a project thread still belongs to the project, even though the
 * inbox never nests it (`effectiveParentThreadId` drops forks).
 *
 * The rail renders each of these threads' only sidebar anchor, so the inbox
 * shelves must not draw them again ("one keyboard anchor" per thread).
 */
export function projectHiddenThreadIds(
  threads: readonly PluginSidebarThread[],
  coordinatorIds: ReadonlySet<string>,
): ReadonlySet<string> {
  if (coordinatorIds.size === 0) return new Set();
  const byParent = childrenByParentId(threads);
  const hidden = new Set<string>();
  const stack = [...coordinatorIds];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (hidden.has(id)) continue;
    hidden.add(id);
    for (const child of byParent.get(id) ?? []) stack.push(child.id);
  }
  return hidden;
}

export interface RailThreadRow {
  threadId: string;
  /** 0 = the coordinator row itself; agents are 1, their children 2, … */
  depth: number;
}

/**
 * The rail's rows for one project, depth-first in spawn order. Recursive by
 * construction: a grandchild renders nested under its agent parent, so no
 * project thread ever disappears from both rail and inbox. Every project
 * thread appears exactly once — that is the "one navigation anchor" rule.
 */
export function railThreadRows(
  threads: readonly PluginSidebarThread[],
  coordinatorThreadId: string,
): RailThreadRow[] {
  const byParent = childrenByParentId(threads);
  const rows: RailThreadRow[] = [{ threadId: coordinatorThreadId, depth: 0 }];
  // The seen set is what makes "exactly one anchor" provable: real ancestry
  // can't cycle, but a malformed feed cannot turn this walk into a loop or a
  // duplicate row either way.
  const seen = new Set([coordinatorThreadId]);
  const visit = (parentId: string, depth: number): void => {
    for (const child of byParent.get(parentId) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      rows.push({ threadId: child.id, depth });
      visit(child.id, depth + 1);
    }
  };
  visit(coordinatorThreadId, 1);
  return rows;
}

/** All descendants of a coordinator (agents + nested), for counts. */
export function projectDescendantCount(
  threads: readonly PluginSidebarThread[],
  coordinatorThreadId: string,
): number {
  return railThreadRows(threads, coordinatorThreadId).length - 1;
}

/**
 * The initiative a thread belongs to: the thread is itself a coordinator, or
 * one of its ancestors is. Bounded by the ancestor chain; a deleted or
 * unlisted parent simply ends the walk.
 */
export function initiativeForThread(
  threads: readonly PluginSidebarThread[],
  threadId: string,
  byCoordinator: ReadonlyMap<string, Initiative>,
): Initiative | null {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const seen = new Set<string>();
  let cursor: string | null = threadId;
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    const initiative = byCoordinator.get(cursor);
    if (initiative !== undefined) return initiative;
    cursor = byId.get(cursor)?.parentThreadId ?? null;
  }
  return null;
}

const CRON_LABELS: Record<string, string> = {
  "0 * * * *": "Every hour",
  "0 9 * * *": "Daily at 09:00",
  "0 9 * * 1-5": "Weekdays at 09:00",
};

/** What a scheduled prompt will do and when, in one short line. */
export function scheduleConfigLabel(config: SubscriptionScheduleConfig, now = Date.now()): string {
  if (config.schedule === "once") {
    const when = new Date(config.runAt);
    return config.runAt <= now
      ? `Ran once · ${when.toLocaleString()}`
      : `Once · ${when.toLocaleString()}`;
  }
  return CRON_LABELS[config.expression] ?? `Cron: ${config.expression}`;
}

/** One line of subscription truth, for trays and the subscriptions list. */
export function subscriptionLabel(subscription: InitiativeSubscription, now = Date.now()): string {
  // Corrupt stored rows list with config null + configError — surface the
  // reason instead of crashing on a null dereference.
  if (subscription.config === null) {
    return subscription.configError ?? "Invalid stored config";
  }
  const { config } = subscription;
  switch (subscription.kind) {
    case "schedule":
      return scheduleConfigLabel(config as SubscriptionScheduleConfig, now);
    case "github-ci":
      return `GitHub CI · ${(config as { repo: string }).repo}`;
    case "github-pr": {
      const c = config as { repo: string; pr: number };
      return `PR #${c.pr} · ${c.repo}`;
    }
    case "slack-channel":
      return `Slack · ${(config as { channelId: string }).channelId}`;
  }
}

/** "repo-a, repo-b" for chips and summaries; the scratch case names itself. */
export function workspaceSummary(
  initiative: Initiative,
  projectNameById: ReadonlyMap<string, string>,
): string {
  if (initiative.workspaceProjectIds.length === 0) return "From scratch";
  return initiative.workspaceProjectIds
    .map((id) => projectNameById.get(id) ?? "Unknown project")
    .join(", ");
}

export type NewProjectWorkspaceMode = InitiativeWorkspace["mode"];

/**
 * Shared directory is the new multi-repository default. Scratch and
 * single-repository projects keep the existing environment flow; an explicit
 * multi-repository choice remains selected as repositories are added.
 */
export function resolveNewProjectWorkspaceMode(
  preferredMode: NewProjectWorkspaceMode,
  selectedRepositoryCount: number,
): NewProjectWorkspaceMode {
  return selectedRepositoryCount >= 2 ? preferredMode : "legacy";
}

/** Request generations let a user edit invalidate a pending preview response. */
export function createLatestRequestGuard() {
  let current = 0;
  return {
    begin: () => ++current,
    invalidate: () => {
      current += 1;
    },
    isCurrent: (request: number) => request === current,
  };
}

/**
 * `datetime-local` inputs read and write in browser-local time; formatting
 * through `toISOString()` would display UTC and silently shift a one-shot
 * schedule by the user's offset. Round-trips with `new Date(value)`.
 */
export function localDatetimeInputValue(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

export type DocReadResolution = "apply" | "conflict" | "ignore";

/**
 * What an in-flight readContextDoc resolution may do to the editor. `dirty`
 * is evaluated at resolve time — the user may have started typing after the
 * read began, so a clean-at-send fetch must not clobber a dirty-at-receive
 * draft; it surfaces as "changed elsewhere" instead. Stale (generation moved
 * to another project/path) and post-delete resolutions are ignored entirely.
 * `force` is for an explicit user reload: it applies the server version over
 * a dirty draft on purpose, which is the only way out of a conflict.
 */
export function resolveDocRead(opts: {
  stale: boolean;
  dirty: boolean;
  deleted: boolean;
  force?: boolean;
}): DocReadResolution {
  if (opts.stale || opts.deleted) return "ignore";
  if (opts.dirty && opts.force !== true) return "conflict";
  return "apply";
}

type InitiativeEvent = { initiativeId?: string | null; path?: string | null };

/**
 * The initiatives channel carries { initiativeId, path? } payloads — writes
 * name the doc, lifecycle events name the initiative, broadcasts name
 * neither. An event counts as relevant only when it names this initiative or
 * no initiative at all, so one project's writes do not mark another's dirty
 * drafts conflicted.
 */
export function eventTargetsInitiative(payload: unknown, initiativeId: string): boolean {
  if (typeof payload !== "object" || payload === null) return true;
  const named = (payload as InitiativeEvent).initiativeId;
  return named === undefined || named === null || named === initiativeId;
}

export function eventTargetsDoc(payload: unknown, path: string): boolean {
  if (typeof payload !== "object" || payload === null) return true;
  const named = (payload as InitiativeEvent).path;
  return named === undefined || named === null || named === path;
}
