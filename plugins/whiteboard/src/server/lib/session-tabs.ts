import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  PANEL_ACTION_ID,
  PLUGIN_ID,
  panelParamsJson,
  panelTabId,
} from "../../shared/contracts/panel.ts";
import type { ReviewStore } from "./vendor/review/src/review-api/store.ts";

/**
 * The one owner of Whiteboard thread tabs and the `session_threads` table
 * (design §3.6). `open-panel.ts` adds tabs through `upsertSessionTab`;
 * `trackSessionTabs` keeps them in step with the store afterwards.
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
export async function editThreadTabs(
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

/** Append the session's tab, or retitle it when the title changed. */
export function upsertSessionTab(
  bb: BbPluginApi,
  threadId: string,
  sessionId: string,
  title: string,
): Promise<void> {
  const wanted = sessionTab(sessionId, title);
  return editThreadTabs(bb, threadId, (tabs) => {
    const index = tabs.findIndex((tab) => tab.id === wanted.id);
    if (index === -1) return [...tabs, wanted];
    const current = tabs[index]!;
    if (current.kind !== "plugin-panel" || current.title === wanted.title) return undefined;
    return tabs.map((tab, i) => (i === index ? { ...current, title: wanted.title } : tab));
  });
}

/** Retitle the session's tab if it is still open. A closed tab stays closed. */
function retitleSessionTab(bb: BbPluginApi, threadId: string, sessionId: string, title: string) {
  const wanted = sessionTab(sessionId, title);
  return editThreadTabs(bb, threadId, (tabs) => {
    const current = tabs.find((tab) => tab.id === wanted.id);
    if (current?.kind !== "plugin-panel" || current.title === wanted.title) return undefined;
    return tabs.map((tab) => (tab.id === wanted.id ? { ...current, title: wanted.title } : tab));
  });
}

function removeSessionTab(bb: BbPluginApi, threadId: string, sessionId: string) {
  const id = sessionTab(sessionId, "").id;
  return editThreadTabs(bb, threadId, (tabs) =>
    tabs.some((tab) => tab.id === id) ? tabs.filter((tab) => tab.id !== id) : undefined,
  );
}

/**
 * When each session last got a tab in this load, as an ISO time comparable
 * with `dismissedAt`. Desktop closes canvases only when a session becomes
 * dismissed (`reviewApiCatalogService.ts` `accept`), so an open after the
 * dismissal keeps its tab. Keyed by the plugin handle, so loads never share it.
 */
const openedAt = new WeakMap<BbPluginApi, Map<string, string>>();

function openTimes(bb: BbPluginApi): Map<string, string> {
  let times = openedAt.get(bb);
  if (!times) openedAt.set(bb, (times = new Map()));
  return times;
}

/** Remember that `threadId` got a tab for `sessionId`. Idempotent. */
export function recordSessionThread(bb: BbPluginApi, sessionId: string, threadId: string): void {
  bb.storage
    .database()
    .prepare("INSERT OR IGNORE INTO session_threads(session_id, thread_id) VALUES (?, ?)")
    .run(sessionId, threadId);
  openTimes(bb).set(sessionId, new Date().toISOString());
}

/** Sessions recorded for one thread, oldest first. */
export function threadSessions(bb: BbPluginApi, threadId: string): string[] {
  return bb.storage
    .database()
    .prepare("SELECT session_id FROM session_threads WHERE thread_id=? ORDER BY rowid")
    .all(threadId)
    .map((row) => String((row as { session_id: unknown }).session_id));
}

function recordedRows(bb: BbPluginApi): { sessionId: string; threadId: string }[] {
  return bb.storage
    .database()
    .prepare("SELECT session_id, thread_id FROM session_threads ORDER BY rowid")
    .all()
    .map((row) => {
      const { session_id, thread_id } = row as { session_id: unknown; thread_id: unknown };
      return { sessionId: String(session_id), threadId: String(thread_id) };
    });
}

/** The store surface tab maintenance reads. `ReviewStore` satisfies it. */
export type SessionTabsStore = Pick<ReviewStore, "subscribeCatalog" | "list" | "has">;

/**
 * Keep recorded thread tabs in step with sessions (design §3.6):
 * - a title change retitles every recorded tab that is still open;
 * - delete or dismiss removes the tab and forgets the thread. A restore does
 *   not re-add it; the next `open` does.
 *
 * Every store change fires the catalog listener, so one listener sees
 * renames, deletes, attention changes and external writes. Sweeps run one at
 * a time; changes during a sweep fold into one more sweep. A failed tab write
 * keeps its row, so the next sweep retries it. Returns an unsubscribe.
 */
export function trackSessionTabs(deps: { bb: BbPluginApi; store: SessionTabsStore }): () => void {
  const { bb, store } = deps;
  /** Titles the recorded tabs are known to carry. Unknown means "check the tab". */
  const titles = new Map<string, string>();
  const opened = openTimes(bb);
  /** Dismissed before its latest open: the tab stays until the next dismissal. */
  const reopened = (sessionId: string, dismissedAt: string) =>
    (opened.get(sessionId) ?? "") > dismissedAt;
  let stopped = false;
  let running: Promise<void> | undefined;
  let again = false;

  const warn = (message: string) => {
    if (!stopped) bb.log.warn(`whiteboard: ${message}`);
  };

  /** Close the tab in every recorded thread. A row stays only while its write keeps failing. */
  const forget = async (sessionId: string, threadIds: string[]) => {
    titles.delete(sessionId);
    opened.delete(sessionId);
    for (const threadId of threadIds) {
      try {
        await removeSessionTab(bb, threadId, sessionId);
      } catch (error) {
        // 404: the thread is gone, and its tabs with it.
        if (!hasStatus(error, 404)) {
          warn(`could not close the tab of ${sessionId} in ${threadId}: ${String(error)}`);
          continue;
        }
      }
      if (stopped) return;
      bb.storage
        .database()
        .prepare("DELETE FROM session_threads WHERE session_id=? AND thread_id=?")
        .run(sessionId, threadId);
    }
  };

  /** Retitle open tabs; remember the title only once every thread has it. */
  const retitle = async (sessionId: string, title: string, threadIds: string[]) => {
    let synced = true;
    for (const threadId of threadIds) {
      try {
        await retitleSessionTab(bb, threadId, sessionId, title);
      } catch (error) {
        if (hasStatus(error, 404)) continue;
        synced = false;
        warn(`could not retitle the tab of ${sessionId} in ${threadId}: ${String(error)}`);
      }
    }
    if (synced) titles.set(sessionId, title);
  };

  const sweep = async () => {
    const rows = recordedRows(bb);
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
      } else if (summary.dismissedAt && !reopened(sessionId, summary.dismissedAt))
        await forget(sessionId, threadIds);
      else if (titles.get(sessionId) !== summary.title)
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

  // Tabs written before this load carry the titles they had then. Seeding
  // them avoids one tab read per recorded row on the first change. A recorded
  // session that is already dismissed was reopened after its dismissal (or its
  // close failed): only a later dismissal closes it, as in Desktop.
  try {
    const recorded = new Set(recordedRows(bb).map((row) => row.sessionId));
    if (recorded.size)
      for (const summary of store.list())
        if (recorded.has(summary.reviewId)) {
          titles.set(summary.reviewId, summary.title);
          if (summary.dismissedAt && !opened.has(summary.reviewId))
            opened.set(summary.reviewId, new Date().toISOString());
        }
  } catch (error) {
    warn(`could not read recorded thread tabs: ${String(error)}`);
  }

  const unsubscribe = store.subscribeCatalog(schedule);
  return () => {
    stopped = true;
    unsubscribe();
  };
}
