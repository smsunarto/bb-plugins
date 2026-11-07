// Completion is a plugin-private shelf for bot conversations. A completed
// conversation leaves the bot's list until new activity reopens it. The
// first ordered root conversation (the bot's default "main" target) is never
// completed or archived automatically.

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

export interface CompletionRecord {
  threadId: string;
  completedAt: number | null;
  /** Explicit un-complete or reopening activity; restarts the idle clock. */
  reopenedAt: number | null;
}

/** The thread facts completion reads, available from both sidebar and SDK rows. */
export interface CompletionThread {
  id: string;
  parentThreadId: string | null;
  createdAt: number;
  updatedAt: number;
  latestAttentionAt: number;
  pinned: boolean;
  busy: boolean;
}

export interface CompletionSettings {
  autoComplete: boolean;
  autoCompleteAfterHours: number;
  autoArchive: boolean;
  autoArchiveAfterDays: number;
}

export const DEFAULT_COMPLETION_SETTINGS: CompletionSettings = {
  autoComplete: true,
  autoCompleteAfterHours: 72,
  autoArchive: false,
  autoArchiveAfterDays: 7,
};

/** Clamp user-entered settings; invalid numbers fall back to defaults. */
export function normalizeCompletionSettings(
  raw: Partial<Record<keyof CompletionSettings, unknown>>,
): CompletionSettings {
  const hours = Number(raw.autoCompleteAfterHours);
  const days = Number(raw.autoArchiveAfterDays);
  return {
    autoComplete:
      raw.autoComplete === undefined
        ? DEFAULT_COMPLETION_SETTINGS.autoComplete
        : raw.autoComplete === true,
    autoCompleteAfterHours:
      Number.isFinite(hours) && hours >= 1 && hours <= 24 * 90
        ? hours
        : DEFAULT_COMPLETION_SETTINGS.autoCompleteAfterHours,
    autoArchive: raw.autoArchive === true,
    autoArchiveAfterDays:
      Number.isFinite(days) && days >= 0 && days <= 365
        ? days
        : DEFAULT_COMPLETION_SETTINGS.autoArchiveAfterDays,
  };
}

/**
 * Whether a stored completion still applies. Live work, a raised hand, or
 * attention newer than the completion bring the conversation back.
 */
export function isCompleted(
  record: CompletionRecord | undefined,
  thread: Pick<CompletionThread, "latestAttentionAt" | "busy">,
): boolean {
  return (
    record?.completedAt != null && !thread.busy && thread.latestAttentionAt <= record.completedAt
  );
}

export function idleSince(thread: CompletionThread, record: CompletionRecord | undefined): number {
  return Math.max(
    thread.createdAt,
    thread.updatedAt,
    thread.latestAttentionAt,
    record?.reopenedAt ?? 0,
  );
}

function childrenIndex<T extends { id: string; parentThreadId: string | null }>(
  threads: readonly T[],
) {
  const ids = new Set(threads.map((thread) => thread.id));
  const children = new Map<string, T[]>();
  for (const thread of threads) {
    if (!thread.parentThreadId || !ids.has(thread.parentThreadId)) continue;
    const list = children.get(thread.parentThreadId) ?? [];
    list.push(thread);
    children.set(thread.parentThreadId, list);
  }
  return children;
}

export function descendantIds<T extends { id: string; parentThreadId: string | null }>(
  threads: readonly T[],
  rootId: string,
): string[] {
  const children = childrenIndex(threads);
  const result: string[] = [];
  const seen = new Set<string>([rootId]);
  const stack = [...(children.get(rootId) ?? [])];
  while (stack.length) {
    const next = stack.pop()!;
    if (seen.has(next.id)) continue;
    seen.add(next.id);
    result.push(next.id);
    stack.push(...(children.get(next.id) ?? []));
  }
  return result;
}

/**
 * Conversations hidden from a bot's list: completed, and with no descendant
 * that still needs to be shown. `keepVisible` (for example the conversation
 * being viewed) overrides completion and keeps its ancestors visible.
 */
export function hiddenCompletedIds<T extends CompletionThread>(
  threads: readonly T[],
  records: ReadonlyMap<string, CompletionRecord>,
  keepVisible: (thread: T) => boolean = () => false,
): Set<string> {
  const children = childrenIndex(threads);
  const visible = new Map<string, boolean>();
  const visit = (thread: T, path: Set<string>): boolean => {
    const cached = visible.get(thread.id);
    if (cached !== undefined) return cached;
    if (path.has(thread.id)) return true;
    path.add(thread.id);
    let shown = keepVisible(thread) || !isCompleted(records.get(thread.id), thread);
    for (const child of children.get(thread.id) ?? []) if (visit(child, path)) shown = true;
    path.delete(thread.id);
    visible.set(thread.id, shown);
    return shown;
  };
  for (const thread of threads) visit(thread, new Set());
  return new Set(threads.filter((thread) => !visible.get(thread.id)).map((thread) => thread.id));
}

export interface CompletionDecision {
  complete: string[];
  archive: string[];
}

/**
 * Decide the automatic transitions for one bot's conversations.
 *
 * `threads` are the bot's non-archived visible conversations; `mainId` is its
 * first ordered visible root, which is never completed or archived here. A
 * parent completes only when its whole subtree is complete or completing, so a
 * quiet parent never hides a child that still has something to say. Archiving
 * cascades to children in BB, so only fully completed top-most subtrees that
 * do not contain the main conversation are archived.
 */
export function decideCompletion({
  threads,
  records,
  mainId,
  now,
  settings,
}: {
  threads: readonly CompletionThread[];
  records: ReadonlyMap<string, CompletionRecord>;
  mainId: string | null;
  now: number;
  settings: CompletionSettings;
}): CompletionDecision {
  const children = childrenIndex(threads);
  const completed = (thread: CompletionThread) => isCompleted(records.get(thread.id), thread);
  const complete: string[] = [];
  if (settings.autoComplete) {
    const cutoff = now - settings.autoCompleteAfterHours * HOUR_MS;
    const candidate = new Map<string, boolean>();
    const qualifies = (thread: CompletionThread, path: Set<string>): boolean => {
      const cached = candidate.get(thread.id);
      if (cached !== undefined) return cached;
      if (path.has(thread.id)) return false;
      path.add(thread.id);
      const self =
        completed(thread) ||
        (thread.id !== mainId &&
          !thread.pinned &&
          !thread.busy &&
          idleSince(thread, records.get(thread.id)) < cutoff);
      const result =
        self && (children.get(thread.id) ?? []).every((child) => qualifies(child, path));
      path.delete(thread.id);
      candidate.set(thread.id, result);
      return result;
    };
    for (const thread of threads) {
      if (!completed(thread) && qualifies(thread, new Set())) complete.push(thread.id);
    }
  }

  const archive: string[] = [];
  if (settings.autoArchive) {
    const cutoff = now - settings.autoArchiveAfterDays * DAY_MS;
    const completing = new Set(complete);
    const completedAt = (thread: CompletionThread) =>
      completing.has(thread.id)
        ? now
        : completed(thread)
          ? records.get(thread.id)!.completedAt!
          : null;
    const byId = new Map(threads.map((thread) => [thread.id, thread]));
    const archivable = (thread: CompletionThread): boolean => {
      if (thread.id === mainId || thread.pinned || thread.busy) return false;
      const at = completedAt(thread);
      if (at === null || at > cutoff) return false;
      return descendantIds(threads, thread.id).every((id) => {
        const child = byId.get(id)!;
        return id !== mainId && !child.pinned && !child.busy && completedAt(child) !== null;
      });
    };
    for (const thread of threads) {
      if (!archivable(thread)) continue;
      // Archive only the top-most archivable ancestor; BB cascades to children.
      const parent = thread.parentThreadId ? byId.get(thread.parentThreadId) : undefined;
      if (parent && archivable(parent)) continue;
      archive.push(thread.id);
    }
  }
  return { complete, archive };
}
