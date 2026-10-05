import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  PANEL_ACTION_ID,
  PLUGIN_ID,
  panelParamsJson,
  panelTabId,
} from "../../shared/contracts/panel.ts";
import { type PendingOpen, PENDING_OPEN_TTL_MS } from "../../shared/contracts/api-tunnel.ts";
import type { ReviewStore } from "./vendor/review/src/review-api/store.ts";

/**
 * The one owner of Whiteboard thread tabs and the `session_threads` table
 * (design §3.6). `open` adds a tab for an agent, `track` records a tab a
 * panel shows, and a catalog sweep keeps every recorded tab in step with the
 * store.
 */

type ThreadTabs = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["tabs"]["get"]>>["tabs"];
type ThreadTab = ThreadTabs[number];
type PluginPanelTab = Extract<ThreadTab, { kind: "plugin-panel" }>;

/** A first write plus three retries on `thread_tabs_conflict` (design §3.6 step 4). */
export const TAB_WRITE_ATTEMPTS = 4;

/** bb's plugin-panel tab title limit (desktop-v0.44.0 server-contract thread-tabs.ts). */
const TAB_TITLE_MAX_LENGTH = 1_024;

/**
 * Upstream titles have no length limit, but bb rejects a longer tab title
 * with 400, so it is cut to fit. Without a lone high surrogate at the cut.
 */
export function tabTitle(title: string): string {
  if (title.length <= TAB_TITLE_MAX_LENGTH) return title;
  return `${title.slice(0, TAB_TITLE_MAX_LENGTH - 1).replace(/[\uD800-\uDBFF]$/, "")}…`;
}

/** The tab bb's client builds for `openThreadPanel({actionId, params: {sessionId}})`. */
export function sessionTab(sessionId: string, title: string): PluginPanelTab {
  const paramsJson = panelParamsJson(sessionId);
  title = tabTitle(title);
  // No `fileOpenerOwner`: it is optional, not nullable, on bb's strict schema.
  return {
    id: panelTabId(paramsJson),
    kind: "plugin-panel",
    pluginId: PLUGIN_ID,
    actionId: PANEL_ACTION_ID,
    title,
    paramsJson,
  };
}

function hasStatus(error: unknown, status: number): boolean {
  return (
    typeof error === "object" && error !== null && "status" in error && error.status === status
  );
}

/** bb's `BbHttpError` for a stale `expectedRevision`, matched by shape across bundles. */
function isTabsConflict(error: unknown): boolean {
  return (
    hasStatus(error, 409) &&
    "code" in (error as object) &&
    (error as { code: unknown }).code === "thread_tabs_conflict"
  );
}

/**
 * Read-modify-write one thread's tabs. `edit` returns the next tab list, or
 * `undefined` for no change. A conflict re-reads and retries; the last
 * error is thrown after `TAB_WRITE_ATTEMPTS`.
 */
async function writeThreadTabs(
  bb: BbPluginApi,
  threadId: string,
  edit: (tabs: ThreadTabs) => ThreadTabs | undefined,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const { revision, tabs } = await bb.sdk.threads.tabs.get({ threadId });
    const next = edit(tabs);
    if (!next) return;
    try {
      await bb.sdk.threads.tabs.update({ threadId, expectedRevision: revision, tabs: next });
      return;
    } catch (error) {
      if (!isTabsConflict(error) || attempt >= TAB_WRITE_ATTEMPTS) throw error;
    }
  }
}

const threadSessionKey = (sessionId: string, threadId: string) =>
  JSON.stringify([sessionId, threadId]);

/** The store surface tab maintenance reads. `ReviewStore` satisfies it. */
export type SessionTabsStore = Pick<ReviewStore, "subscribeCatalog" | "list" | "has">;

export interface SessionTabs {
  /**
   * An agent opened `sessionId` from `threadId`: append or retitle its tab,
   * record the thread, and leave the open for `claimOpen`. Answers the open's
   * `at`, which increases per load. A failed tab write throws and records
   * nothing.
   */
  open(threadId: string, sessionId: string, title: string): Promise<number>;
  /** A panel shows `sessionId` in `threadId`: record it, so the tab follows renames and removals. */
  track(threadId: string, sessionId: string): void;
  /**
   * Read the thread's last agent open if it is newer than `after`, under 5
   * minutes old and its tab is still open. Reading keeps it; an `after` at or
   * past it forgets it. A failed tab read throws and keeps it.
   */
  claimOpen(threadId: string, after?: number): Promise<PendingOpen | null>;
  /** Stop following the store. */
  dispose(): void;
}

/**
 * Keep recorded thread tabs in step with sessions (design §3.6):
 * - a title change retitles every recorded tab that is still open;
 * - delete or dismiss removes the tab and forgets the thread. A restore does
 *   not re-add it; the next `open` does.
 *
 * Every store change fires the catalog listener, so one listener sees
 * renames, deletes, attention changes and external writes. Sweeps run one at
 * a time; changes during a sweep fold into one more sweep. A failed tab write
 * keeps its row, so the next sweep retries it.
 */
export function createSessionTabs(deps: { bb: BbPluginApi; store: SessionTabsStore }): SessionTabs {
  const { bb, store } = deps;
  const db = () => bb.storage.database();
  /** Serialize this load's writes to one thread. The server revision still arbitrates other clients. */
  const queues = new Map<string, Promise<void>>();
  /** Open attempts invalidate an older close, even while their own tab write is queued. */
  const generations = new Map<string, number>();
  /**
   * When each session got a tab in a thread, as an ISO time comparable with
   * `dismissedAt`. Desktop closes canvases only when a session becomes
   * dismissed (`reviewApiCatalogService.ts` `accept`), so an open after the
   * dismissal keeps its tab.
   */
  const opened = new Map<string, string>();
  /** Titles the recorded tabs are known to carry. Unknown means "check the tab". */
  const titles = new Map<string, string>();
  const dismissalGenerations = new Map<string, { at: string; generation?: number }>();
  /** Per thread, the last agent open no client has focused yet. */
  const pending = new Map<string, { sessionId: string; at: number }>();
  /** Opens' `at`: the clock, made strictly increasing. */
  let lastAt = 0;
  let stopped = false;
  let running: Promise<void> | undefined;
  let again = false;

  const warn = (message: string) => {
    if (!stopped) bb.log.warn(`whiteboard: ${message}`);
  };

  const editThreadTabs = (
    threadId: string,
    edit: (tabs: ThreadTabs) => ThreadTabs | undefined,
  ): Promise<void> => {
    const previous = queues.get(threadId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => writeThreadTabs(bb, threadId, edit));
    queues.set(threadId, next);
    void next
      .finally(() => {
        if (queues.get(threadId) === next) queues.delete(threadId);
      })
      .catch(() => {});
    return next;
  };

  /** Retitle the session's tab if it is still open. A closed tab stays closed. */
  const retitleSessionTab = (threadId: string, sessionId: string, title: string) => {
    const wanted = sessionTab(sessionId, title);
    return editThreadTabs(threadId, (tabs) => {
      const current = tabs.find((tab) => tab.id === wanted.id);
      if (current?.kind !== "plugin-panel" || current.title === wanted.title) return undefined;
      return tabs.map((tab) => (tab.id === wanted.id ? { ...current, title: wanted.title } : tab));
    });
  };

  const removeSessionTab = (threadId: string, sessionId: string, stale: () => boolean) => {
    const id = sessionTab(sessionId, "").id;
    return editThreadTabs(threadId, (tabs) =>
      !stale() && tabs.some((tab) => tab.id === id)
        ? tabs.filter((tab) => tab.id !== id)
        : undefined,
    );
  };

  /** Idempotent. */
  const record = (sessionId: string, threadId: string) =>
    db()
      .prepare("INSERT OR IGNORE INTO session_threads(session_id, thread_id) VALUES (?, ?)")
      .run(sessionId, threadId);

  const recordedRows = (): { sessionId: string; threadId: string }[] =>
    db()
      .prepare("SELECT session_id, thread_id FROM session_threads ORDER BY rowid")
      .all()
      .map((row) => {
        const { session_id, thread_id } = row as { session_id: unknown; thread_id: unknown };
        return { sessionId: String(session_id), threadId: String(thread_id) };
      });

  /** The generation disambiguates a reopen and dismissal in the same millisecond. */
  const reopened = (sessionId: string, threadId: string, dismissedAt: string) => {
    const key = threadSessionKey(sessionId, threadId);
    return (
      (opened.get(key) ?? "") > dismissedAt ||
      (dismissalGenerations.get(key)?.at === dismissedAt &&
        dismissalGenerations.get(key)?.generation !== generations.get(key))
    );
  };

  /** Close the tab in every recorded thread. A row stays only while its write keeps failing. */
  const forget = async (sessionId: string, threadIds: string[]) => {
    titles.delete(sessionId);
    for (const threadId of threadIds) {
      const key = threadSessionKey(sessionId, threadId);
      const generation = generations.get(key);
      const stale = () => stopped || generations.get(key) !== generation;
      try {
        await removeSessionTab(threadId, sessionId, stale);
      } catch (error) {
        // 404: the thread is gone, and its tabs with it.
        if (!hasStatus(error, 404)) {
          warn(`could not close the tab of ${sessionId} in ${threadId}: ${String(error)}`);
          continue;
        }
      }
      if (stale()) continue;
      opened.delete(key);
      if (pending.get(threadId)?.sessionId === sessionId) pending.delete(threadId);
      db()
        .prepare("DELETE FROM session_threads WHERE session_id=? AND thread_id=?")
        .run(sessionId, threadId);
    }
  };

  /** Retitle open tabs; remember the title only once every thread has it. */
  const retitle = async (sessionId: string, title: string, threadIds: string[]) => {
    let synced = true;
    for (const threadId of threadIds) {
      try {
        await retitleSessionTab(threadId, sessionId, title);
      } catch (error) {
        if (hasStatus(error, 404)) continue;
        synced = false;
        warn(`could not retitle the tab of ${sessionId} in ${threadId}: ${String(error)}`);
      }
    }
    if (synced) titles.set(sessionId, title);
  };

  const dismiss = async (
    sessionId: string,
    dismissedAt: string,
    title: string,
    threadIds: string[],
  ) => {
    for (const threadId of threadIds) {
      const key = threadSessionKey(sessionId, threadId);
      if (dismissalGenerations.get(key)?.at !== dismissedAt)
        dismissalGenerations.set(key, { at: dismissedAt, generation: generations.get(key) });
    }
    const closedThreads = threadIds.filter(
      (threadId) => !reopened(sessionId, threadId, dismissedAt),
    );
    if (closedThreads.length) await forget(sessionId, closedThreads);
    const retainedThreads = threadIds.filter((threadId) =>
      reopened(sessionId, threadId, dismissedAt),
    );
    if (retainedThreads.length && titles.get(sessionId) !== title)
      await retitle(sessionId, title, retainedThreads);
  };

  const sweep = async () => {
    const rows = recordedRows();
    if (!rows.length) return;
    const listed = new Map(store.list().map((summary) => [summary.reviewId, summary]));
    const bySession = Map.groupBy(rows, (row) => row.sessionId);
    for (const [sessionId, sessionRows] of bySession) {
      if (stopped) return;
      const threadIds = sessionRows.map((row) => row.threadId);
      const summary = listed.get(sessionId);
      if (!summary) {
        // Tutorial sessions are hidden from the catalog but still exist.
        if (!store.has(sessionId)) await forget(sessionId, threadIds);
      } else if (summary.dismissedAt) {
        await dismiss(sessionId, summary.dismissedAt, summary.title, threadIds);
      } else if (titles.get(sessionId) !== summary.title)
        await retitle(sessionId, summary.title, threadIds);
    }
  };

  const schedule = () => {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = (async () => {
      again = true;
      while (again) {
        again = false;
        try {
          await sweep();
        } catch (error) {
          warn(`thread tab sweep failed: ${String(error)}`);
        }
        if (stopped) return;
      }
    })().finally(() => {
      running = undefined;
    });
  };

  // A recorded session that is already dismissed was reopened after its
  // dismissal (or its close failed): only a later dismissal closes it, as in
  // Desktop. Titles are not seeded: a retitle that failed before this load
  // left its tab stale, so the first sweep reads every recorded tab once.
  const seed = () => {
    const rows = recordedRows();
    const recorded = new Set(rows.map((row) => row.sessionId));
    if (!recorded.size) return;
    for (const summary of store.list()) {
      if (!recorded.has(summary.reviewId) || !summary.dismissedAt) continue;
      for (const row of rows.filter((row) => row.sessionId === summary.reviewId)) {
        const key = threadSessionKey(row.sessionId, row.threadId);
        if (!opened.has(key)) opened.set(key, new Date().toISOString());
      }
    }
  };
  try {
    seed();
  } catch (error) {
    warn(`could not read recorded thread tabs: ${String(error)}`);
  }

  const unsubscribe = store.subscribeCatalog(schedule);
  return {
    async open(threadId, sessionId, title) {
      const key = threadSessionKey(sessionId, threadId);
      generations.set(key, (generations.get(key) ?? 0) + 1);
      const wanted = sessionTab(sessionId, title);
      await editThreadTabs(threadId, (tabs) => {
        const index = tabs.findIndex((tab) => tab.id === wanted.id);
        if (index === -1) return [...tabs, wanted];
        const current = tabs[index]!;
        if (current.kind !== "plugin-panel" || current.title === wanted.title) return undefined;
        return tabs.map((tab, i) => (i === index ? { ...current, title: wanted.title } : tab));
      });
      record(sessionId, threadId);
      opened.set(key, new Date().toISOString());
      lastAt = Math.max(Date.now(), lastAt + 1);
      pending.set(threadId, { sessionId, at: lastAt });
      return lastAt;
    },
    track(threadId, sessionId) {
      record(sessionId, threadId);
      // A first sighting counts as an open, so a dismissed session opened from
      // Home keeps its tab. A remount never moves the time past a dismissal.
      const key = threadSessionKey(sessionId, threadId);
      if (!opened.has(key)) opened.set(key, new Date().toISOString());
    },
    async claimOpen(threadId, after) {
      const entry = pending.get(threadId);
      if (!entry) return null;
      if (
        (after !== undefined && entry.at <= after) ||
        Date.now() - entry.at > PENDING_OPEN_TTL_MS
      ) {
        pending.delete(threadId);
        return null;
      }
      // The tab as it is now: `openThreadPanel` re-creates a tab the user
      // closed since, and writes its title over the one a rename left.
      const id = sessionTab(entry.sessionId, "").id;
      const { tabs } = await bb.sdk.threads.tabs.get({ threadId });
      // A client that focused it, or a newer open, may have moved on meanwhile.
      if (pending.get(threadId) !== entry) return null;
      const tab = tabs.find((candidate) => candidate.id === id);
      if (tab?.kind === "plugin-panel")
        return { sessionId: entry.sessionId, title: tab.title, at: entry.at };
      // A closed tab stays closed.
      pending.delete(threadId);
      return null;
    },
    dispose() {
      stopped = true;
      pending.clear();
      unsubscribe();
    },
  };
}
