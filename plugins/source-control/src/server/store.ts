/**
 * Last-good facets and thread placements in the plugin's SQLite database,
 * so every client, a phone included, gets "Read 12 min ago" even after a
 * restart. Facets are normalized by their source: a checkout's local facet
 * by (host, path), a forge facet by ChangeKey, so two threads or two hosts
 * on one branch share one pull request read.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  EMPTY_FACET,
  checksValueSchema,
  facetSchema,
  forgeValueSchema,
  placementSchema,
  problemSchema,
  workspaceValueSchema,
  type ChecksValue,
  type Facet,
  type ForgeValue,
  type Placement,
  type WorkspaceValue,
} from "../core/change.ts";
import type { ChangeKey } from "../core/ids.ts";
import { guideSchema, guideStateSchema, type Viewed } from "../core/guide.ts";
import {
  batchSchema,
  DEFAULT_TRAY,
  draftSchema,
  forgeThreadSchema,
  traySchema,
  type Batch,
  type Tray,
  reviewItemSchema,
  reviewRunSchema,
  type Draft,
  type ForgeThread,
  type ReviewItem,
  type ReviewRun,
} from "../core/items.ts";
import { sourceRowsSchema, type SourceRows } from "../core/review.ts";
import type { ReadAs } from "../contract/host.ts";

/** Where a thread's Change comes from, or why it has none. */
export type ThreadPlacement =
  | { state: "none"; reason: string }
  | { state: "checkout"; placement: Placement };

const threadPlacementSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("none"), reason: z.string() }).strict(),
  z.object({ state: z.literal("checkout"), placement: placementSchema }).strict(),
]);
const localFacetSchema = facetSchema(workspaceValueSchema);
const forgeFacetSchema = facetSchema(forgeValueSchema);
const checksFacetSchema = facetSchema(checksValueSchema);
const threadsFacetSchema = facetSchema(z.array(forgeThreadSchema));

type Database = ReturnType<BbPluginApi["storage"]["database"]>;

/** Numbered and never edited once landed: append only. */
const MIGRATIONS = [
  `CREATE TABLE thread_placement (thread_id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE local_facet (host_id TEXT NOT NULL, path TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (host_id, path))`,
  `CREATE TABLE forge_facet (change_key TEXT PRIMARY KEY, json TEXT NOT NULL)`,
  // Phase 2: the local facet became the workspace shape; earlier rows no longer parse.
  `DELETE FROM local_facet`,
  `CREATE TABLE thread_checkout (thread_id TEXT PRIMARY KEY, host_id TEXT NOT NULL, path TEXT NOT NULL)`,
  `CREATE INDEX thread_checkout_by_checkout ON thread_checkout (host_id, path)`,
  `CREATE TABLE checkout_read_as (host_id TEXT NOT NULL, path TEXT NOT NULL, read_as TEXT NOT NULL, PRIMARY KEY (host_id, path))`,
  `CREATE TABLE thread_branch (thread_id TEXT PRIMARY KEY, branch TEXT)`,
  // Phase 3: pull requests gained approvals; earlier rows no longer parse.
  `DELETE FROM forge_facet`,
  `CREATE TABLE checks_facet (change_key TEXT PRIMARY KEY, json TEXT NOT NULL)`,
  // Phase 4: pull requests gained mergeable and diff stats.
  `DELETE FROM forge_facet`,
  `CREATE TABLE inbox_facet (login TEXT PRIMARY KEY, json TEXT NOT NULL)`,
  // Phase 5: review items, drafts and the reader's selection, by ChangeKey.
  `CREATE TABLE threads_facet (change_key TEXT PRIMARY KEY, json TEXT NOT NULL)`,
  `CREATE TABLE review_run (thread_id TEXT PRIMARY KEY, change_key TEXT NOT NULL, started_at INTEGER NOT NULL, json TEXT NOT NULL)`,
  `CREATE INDEX review_run_by_change ON review_run (change_key, started_at)`,
  `CREATE TABLE finding (change_key TEXT NOT NULL, id TEXT NOT NULL, thread_id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (change_key, id))`,
  `CREATE INDEX finding_by_thread ON finding (thread_id)`,
  `CREATE TABLE draft (change_key TEXT NOT NULL, id TEXT NOT NULL, created_at INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (change_key, id))`,
  `CREATE TABLE selection (change_key TEXT NOT NULL, item_id TEXT NOT NULL, PRIMARY KEY (change_key, item_id))`,
  // Phase 5B: dismissed findings, batches and the send tray.
  `CREATE TABLE dismissed (change_key TEXT NOT NULL, item_id TEXT NOT NULL, PRIMARY KEY (change_key, item_id))`,
  `CREATE TABLE batch (id TEXT PRIMARY KEY, change_key TEXT NOT NULL, created_at INTEGER NOT NULL, json TEXT NOT NULL, payload TEXT NOT NULL)`,
  `CREATE INDEX batch_by_change ON batch (change_key, created_at)`,
  `CREATE TABLE tray (change_key TEXT PRIMARY KEY, json TEXT NOT NULL)`,
  // Phase 6: the guide per Change, viewed marks by blob, and who "You" is per repository.
  `CREATE TABLE guide (change_key TEXT PRIMARY KEY, state TEXT NOT NULL, thread_id TEXT, queued_at INTEGER NOT NULL, json TEXT NOT NULL)`,
  `CREATE INDEX guide_by_thread ON guide (thread_id)`,
  `CREATE INDEX guide_by_state ON guide (state, queued_at)`,
  `CREATE TABLE viewed (change_key TEXT NOT NULL, path TEXT NOT NULL, blob TEXT NOT NULL, PRIMARY KEY (change_key, path, blob))`,
  `CREATE TABLE viewer (repo TEXT PRIMARY KEY, login TEXT NOT NULL)`,
  // Phase 7: the one Ask thread per Change.
  `CREATE TABLE ask_thread (change_key TEXT PRIMARY KEY, thread_id TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  // Phase 8: pull request watches, landed work a thread still waits on, and pinned pull requests.
  `CREATE TABLE pr_watch (thread_id TEXT NOT NULL, pr_key TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (thread_id, pr_key))`,
  `CREATE INDEX pr_watch_by_pr ON pr_watch (pr_key)`,
  `CREATE TABLE landed_track (thread_id TEXT PRIMARY KEY, json TEXT NOT NULL)`,
  `CREATE TABLE pin (pr_key TEXT PRIMARY KEY, json TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  // An old `::code-review{branch=…}` card names a GitButler branch id; this is its Change.
  `CREATE TABLE legacy_branch (branch_id TEXT PRIMARY KEY, change_key TEXT NOT NULL)`,
];

export type Store = ReturnType<typeof openStore>;

/** Whether a facet now says something else than before. When it was read is not news: a client shows it only beside a problem. */
function sameFacet<T>(before: Facet<T>, after: Facet<T>): boolean {
  return (
    JSON.stringify([before.read?.value ?? null, before.read === null, before.problem]) ===
    JSON.stringify([after.read?.value ?? null, after.read === null, after.problem])
  );
}

/** A stored row in its schema, or null when it no longer parses (written by an older shape). */
function parsed<T>(schema: z.ZodType<T>, json: string): T | null {
  try {
    const result = schema.safeParse(JSON.parse(json));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** Dismissed findings, batches with what they carry, and the send tray. */
function sendingTables(
  db: Database,
  rows: <T>(schema: z.ZodType<T>, list: { json: string }[]) => T[],
) {
  const dismissedOf = db.prepare<[string], { item_id: string }>(
    `SELECT item_id FROM dismissed WHERE change_key = ?`,
  );
  const dismiss = db.prepare(
    `INSERT INTO dismissed (change_key, item_id) VALUES (?, ?) ON CONFLICT DO NOTHING`,
  );
  const unselect = db.prepare(`DELETE FROM selection WHERE change_key = ? AND item_id = ?`);
  const getBatch = db.prepare<[string], { change_key: string; json: string; payload: string }>(
    `SELECT change_key, json, payload FROM batch WHERE id = ?`,
  );
  const insertBatch = db.prepare(
    `INSERT INTO batch (id, change_key, created_at, json, payload) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
  );
  const updateBatch = db.prepare(`UPDATE batch SET json = ? WHERE id = ?`);
  const batchesOf = db.prepare<[string], { json: string }>(
    `SELECT json FROM batch WHERE change_key = ? ORDER BY created_at DESC, id LIMIT 20`,
  );
  const batchesByThread = db.prepare<[string], { change_key: string }>(
    `SELECT DISTINCT change_key FROM batch WHERE json ->> '$.threadId' = ?`,
  );
  const getTray = db.prepare<[string], { json: string }>(
    `SELECT json FROM tray WHERE change_key = ?`,
  );
  const putTray = db.prepare(
    `INSERT INTO tray (change_key, json) VALUES (?, ?) ON CONFLICT (change_key) DO UPDATE SET json = excluded.json`,
  );
  const dropDraft = db.prepare(`DELETE FROM draft WHERE change_key = ? AND id = ?`);

  const tray = (key: ChangeKey): Tray => {
    const row = getTray.get(key);
    return (row && parsed(traySchema, row.json)) ?? DEFAULT_TRAY;
  };
  return {
    dismissed: (key: ChangeKey): Set<string> =>
      new Set(dismissedOf.all(key).map((row) => row.item_id)),
    /** Dismisses an item and unchecks it; true when it was not dismissed before. */
    dismiss: db.transaction((key: ChangeKey, id: string) => {
      unselect.run(key, id);
      return dismiss.run(key, id).changes > 0;
    }),
    batch(id: string): { key: ChangeKey; batch: Batch; payload: string } | null {
      const row = getBatch.get(id);
      const batch = row ? parsed(batchSchema, row.json) : null;
      return row && batch
        ? { key: row.change_key as ChangeKey, batch, payload: row.payload }
        : null;
    },
    /** Stores a new batch with what it carries; false when the id is taken. */
    acceptBatch(key: ChangeKey, batch: Batch, payload: string): boolean {
      return (
        insertBatch.run(batch.id, key, batch.createdAt, JSON.stringify(batch), payload).changes > 0
      );
    },
    putBatch(batch: Batch): void {
      updateBatch.run(JSON.stringify(batch), batch.id);
    },
    /** A sent batch: its items leave the selection and its drafts are gone, in one step. */
    settleSent: db.transaction((key: ChangeKey, batch: Batch) => {
      updateBatch.run(JSON.stringify(batch), batch.id);
      for (const id of batch.itemIds) unselect.run(key, id);
      for (const id of batch.draftIds) dropDraft.run(key, id);
    }),
    batches: (key: ChangeKey): Batch[] => rows(batchSchema, batchesOf.all(key)),
    /** Changes with a batch sent to this thread. */
    changesSentTo: (threadId: string): ChangeKey[] =>
      batchesByThread.all(threadId).map((row) => row.change_key as ChangeKey),
    tray,
    setTray(key: ChangeKey, value: Tray): boolean {
      const changed = JSON.stringify(tray(key)) !== JSON.stringify(value);
      putTray.run(key, JSON.stringify(value));
      return changed;
    },
  };
}

/**
 * A guide run's stored record. `state` is the row's; a `running` row with no
 * thread is waiting for a free slot. `files` is the revision's file list the
 * run was given: the write tool accepts only these paths and takes their blobs.
 */
export const guideRowSchema = z
  .object({
    state: guideStateSchema,
    threadId: z.string().nullable(),
    revision: z.string().nullable(),
    guide: guideSchema.nullable(),
    problem: problemSchema.nullable(),
    queuedAt: z.number(),
    startedAt: z.number().nullable(),
    files: z.array(z.object({ path: z.string(), blob: z.string().nullable() }).strict()).nullable(),
  })
  .strict();
export type GuideRow = z.infer<typeof guideRowSchema>;

/** Guide runs, viewed marks and the viewer per repository. */
function guideTables(db: Database) {
  const getGuide = db.prepare<[string], { json: string }>(
    `SELECT json FROM guide WHERE change_key = ?`,
  );
  const putGuide = db.prepare(
    `INSERT INTO guide (change_key, state, thread_id, queued_at, json) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (change_key) DO UPDATE SET state = excluded.state, thread_id = excluded.thread_id,
       queued_at = excluded.queued_at, json = excluded.json`,
  );
  const byThread = db.prepare<[string], { change_key: string; json: string }>(
    `SELECT change_key, json FROM guide WHERE thread_id = ?`,
  );
  const running = db.prepare<[], { change_key: string; json: string }>(
    `SELECT change_key, json FROM guide WHERE state = 'running' ORDER BY queued_at, change_key`,
  );
  const viewedOf = db.prepare<[string], { path: string; blob: string }>(
    `SELECT path, blob FROM viewed WHERE change_key = ? LIMIT 10000`,
  );
  const markViewed = db.prepare(
    `INSERT INTO viewed (change_key, path, blob) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
  );
  const unmarkViewed = db.prepare(
    `DELETE FROM viewed WHERE change_key = ? AND path = ? AND blob = ?`,
  );
  const getViewer = db.prepare<[string], { login: string }>(
    `SELECT login FROM viewer WHERE repo = ?`,
  );
  const putViewer = db.prepare(
    `INSERT INTO viewer (repo, login) VALUES (?, ?) ON CONFLICT (repo) DO UPDATE SET login = excluded.login`,
  );

  const guide = (key: ChangeKey): GuideRow | null => {
    const row = getGuide.get(key);
    return row ? parsed(guideRowSchema, row.json) : null;
  };
  const put = (key: ChangeKey, row: GuideRow) =>
    putGuide.run(key, row.state, row.threadId, row.queuedAt, JSON.stringify(row));
  return {
    guide,
    putGuide: put,
    /**
     * Queues the Change's guide run when it has none, or when `again` and
     * none is running: one transaction, so two clients claim once.
     */
    claimGuide: db.transaction((key: ChangeKey, now: number, again: boolean): boolean => {
      const before = guide(key);
      if (before?.state === "running") return false;
      if (before && before.state !== "none" && !again) return false;
      put(key, {
        state: "running",
        threadId: null,
        revision: null,
        guide: before?.guide ?? null,
        problem: null,
        queuedAt: now,
        startedAt: null,
        files: null,
      });
      return true;
    }),
    guideByThread(threadId: string): { key: ChangeKey; row: GuideRow } | null {
      const row = byThread.get(threadId);
      const value = row ? parsed(guideRowSchema, row.json) : null;
      return row && value ? { key: row.change_key as ChangeKey, row: value } : null;
    },
    /** Running rows, oldest queued first: started ones and those waiting. */
    runningGuides(): { key: ChangeKey; row: GuideRow }[] {
      return running.all().flatMap((row) => {
        const value = parsed(guideRowSchema, row.json);
        return value ? [{ key: row.change_key as ChangeKey, row: value }] : [];
      });
    },
    viewed: (key: ChangeKey): Viewed[] => viewedOf.all(key),
    /** Marks or unmarks a file at a blob; true when that changed anything. */
    setViewed(key: ChangeKey, path: string, blob: string, viewed: boolean): boolean {
      return (viewed ? markViewed : unmarkViewed).run(key, path, blob).changes > 0;
    },
    viewer: (repo: string): string | null => getViewer.get(repo.toLowerCase())?.login ?? null,
    setViewer(repo: string, login: string): void {
      putViewer.run(repo.toLowerCase(), login);
    },
  };
}

/** The Ask thread of each Change: a hidden fork made on its first message. */
function askTables(db: Database) {
  const getAsk = db.prepare<[string], { thread_id: string }>(
    `SELECT thread_id FROM ask_thread WHERE change_key = ?`,
  );
  const putAsk = db.prepare(
    `INSERT INTO ask_thread (change_key, thread_id, created_at) VALUES (?, ?, ?)
     ON CONFLICT (change_key) DO UPDATE SET thread_id = excluded.thread_id, created_at = excluded.created_at`,
  );
  return {
    askThread: (key: ChangeKey): string | null => getAsk.get(key)?.thread_id ?? null,
    setAskThread(key: ChangeKey, threadId: string, now: number): void {
      putAsk.run(key, threadId, now);
    },
  };
}

/** Pull request watches, landed work, pins and old branch ids: rows the cutover imports into. */
function cutoverTables(db: Database) {
  const watchesOf = db.prepare<[string], { pr_key: string; json: string }>(
    `SELECT pr_key, json FROM pr_watch WHERE thread_id = ?`,
  );
  const allWatches = db.prepare<[], { thread_id: string; pr_key: string; json: string }>(
    `SELECT thread_id, pr_key, json FROM pr_watch`,
  );
  const watchersOf = db.prepare<[string], { thread_id: string }>(
    `SELECT thread_id FROM pr_watch WHERE pr_key = ?`,
  );
  const getWatch = db.prepare<[string, string], { json: string }>(
    `SELECT json FROM pr_watch WHERE thread_id = ? AND pr_key = ?`,
  );
  const putWatch = db.prepare(
    `INSERT INTO pr_watch (thread_id, pr_key, json) VALUES (?, ?, ?)
     ON CONFLICT (thread_id, pr_key) DO UPDATE SET json = excluded.json`,
  );
  const dropWatch = db.prepare(`DELETE FROM pr_watch WHERE thread_id = ? AND pr_key = ?`);
  const dropWatches = db.prepare(`DELETE FROM pr_watch WHERE thread_id = ?`);
  const getLanded = db.prepare<[string], { json: string }>(
    `SELECT json FROM landed_track WHERE thread_id = ?`,
  );
  const allLanded = db.prepare<[], { thread_id: string }>(`SELECT thread_id FROM landed_track`);
  const putLanded = db.prepare(
    `INSERT INTO landed_track (thread_id, json) VALUES (?, ?)
     ON CONFLICT (thread_id) DO UPDATE SET json = excluded.json`,
  );
  const dropLanded = db.prepare(`DELETE FROM landed_track WHERE thread_id = ?`);
  const allPins = db.prepare<[], { json: string }>(
    `SELECT json FROM pin ORDER BY created_at DESC, pr_key LIMIT 50`,
  );
  const putPin = db.prepare(
    `INSERT INTO pin (pr_key, json, created_at) VALUES (?, ?, ?) ON CONFLICT (pr_key) DO NOTHING`,
  );
  const dropPin = db.prepare(`DELETE FROM pin WHERE pr_key = ?`);
  const getLegacy = db.prepare<[string], { change_key: string }>(
    `SELECT change_key FROM legacy_branch WHERE branch_id = ?`,
  );
  const putLegacy = db.prepare(
    `INSERT INTO legacy_branch (branch_id, change_key) VALUES (?, ?) ON CONFLICT (branch_id) DO NOTHING`,
  );
  const watchKey = (key: string) => key.toLowerCase();
  return {
    /** Every watch, as stored: the watch service parses them. */
    watchRows: () => allWatches.all(),
    watchRowsOf: (threadId: string) => watchesOf.all(threadId),
    watchRow: (threadId: string, prKey: string): string | null =>
      getWatch.get(threadId, watchKey(prKey))?.json ?? null,
    /** Threads that watch the pull request. */
    watchersOf: (prKey: string) => watchersOf.all(watchKey(prKey)).map((row) => row.thread_id),
    putWatch(threadId: string, prKey: string, json: string): void {
      putWatch.run(threadId, watchKey(prKey), json);
    },
    dropWatch: (threadId: string, prKey: string): boolean =>
      dropWatch.run(threadId, watchKey(prKey)).changes > 0,
    dropWatches: (threadId: string): boolean => dropWatches.run(threadId).changes > 0,
    landedRow: (threadId: string): string | null => getLanded.get(threadId)?.json ?? null,
    landedThreads: () => allLanded.all().map((row) => row.thread_id),
    putLanded(threadId: string, json: string): void {
      putLanded.run(threadId, json);
    },
    dropLanded(threadId: string): void {
      dropLanded.run(threadId);
    },
    pinRows: () => allPins.all().map((row) => row.json),
    /** True when the pin is new. */
    putPin: (prKey: string, json: string, now: number): boolean =>
      putPin.run(prKey.toLowerCase(), json, now).changes > 0,
    dropPin: (prKey: string): boolean => dropPin.run(prKey.toLowerCase()).changes > 0,
    legacyBranch: (branchId: string): ChangeKey | null =>
      (getLegacy.get(branchId)?.change_key as ChangeKey | undefined) ?? null,
    /** True when the mapping is new. */
    putLegacyBranch: (branchId: string, key: ChangeKey): boolean =>
      putLegacy.run(branchId, key).changes > 0,
  };
}

/** The review page's own state: GitHub's threads, bb's findings and runs, drafts and the selection. */
function reviewTables(db: Database) {
  const getThreads = db.prepare<[string], { json: string }>(
    `SELECT json FROM threads_facet WHERE change_key = ?`,
  );
  const putThreads = db.prepare(
    `INSERT INTO threads_facet (change_key, json) VALUES (?, ?) ON CONFLICT (change_key) DO UPDATE SET json = excluded.json`,
  );
  const runsOf = db.prepare<[string], { json: string }>(
    `SELECT json FROM review_run WHERE change_key = ? ORDER BY started_at DESC LIMIT 10`,
  );
  const getRun = db.prepare<[string], { change_key: string; json: string }>(
    `SELECT change_key, json FROM review_run WHERE thread_id = ?`,
  );
  const putRun = db.prepare(
    `INSERT INTO review_run (thread_id, change_key, started_at, json) VALUES (?, ?, ?, ?)
     ON CONFLICT (thread_id) DO UPDATE SET json = excluded.json`,
  );
  const findingsOf = db.prepare<[string], { json: string }>(
    `SELECT json FROM finding WHERE change_key = ? ORDER BY rowid`,
  );
  const dropFindings = db.prepare(`DELETE FROM finding WHERE change_key = ? AND thread_id = ?`);
  const putFinding = db.prepare(
    `INSERT INTO finding (change_key, id, thread_id, json) VALUES (?, ?, ?, ?)
     ON CONFLICT (change_key, id) DO UPDATE SET json = excluded.json`,
  );
  const draftsOf = db.prepare<[string], { json: string }>(
    `SELECT json FROM draft WHERE change_key = ? ORDER BY created_at, id`,
  );
  const getDraft = db.prepare<[string, string], { json: string }>(
    `SELECT json FROM draft WHERE change_key = ? AND id = ?`,
  );
  const putDraft = db.prepare(
    `INSERT INTO draft (change_key, id, created_at, json) VALUES (?, ?, ?, ?)
     ON CONFLICT (change_key, id) DO UPDATE SET json = excluded.json`,
  );
  const dropDraft = db.prepare(`DELETE FROM draft WHERE change_key = ? AND id = ?`);
  const selectedOf = db.prepare<[string], { item_id: string }>(
    `SELECT item_id FROM selection WHERE change_key = ? ORDER BY item_id`,
  );
  const select = db.prepare(
    `INSERT INTO selection (change_key, item_id) VALUES (?, ?) ON CONFLICT DO NOTHING`,
  );
  const unselect = db.prepare(`DELETE FROM selection WHERE change_key = ? AND item_id = ?`);
  const rows = <T>(schema: z.ZodType<T>, list: { json: string }[]): T[] =>
    list.flatMap((row) => {
      const value = parsed(schema, row.json);
      return value === null ? [] : [value];
    });

  const threads = (key: ChangeKey): Facet<ForgeThread[]> => {
    const row = getThreads.get(key);
    return (row && parsed(threadsFacetSchema, row.json)) ?? EMPTY_FACET;
  };
  const draft = (key: ChangeKey, id: string): Draft | null => {
    const row = getDraft.get(key, id);
    return row ? parsed(draftSchema, row.json) : null;
  };

  const sending = sendingTables(db, rows);
  return {
    ...sending,
    /** GitHub's review threads on the Change's pull request. */
    threads,
    setThreads(key: ChangeKey, facet: Facet<ForgeThread[]>): boolean {
      const changed = !sameFacet(threads(key), facet);
      putThreads.run(key, JSON.stringify(facet));
      return changed;
    },
    /** bb reviews of the Change, newest first. */
    runs: (key: ChangeKey): ReviewRun[] => rows(reviewRunSchema, runsOf.all(key)),
    run(threadId: string): { key: ChangeKey; run: ReviewRun } | null {
      const row = getRun.get(threadId);
      const run = row ? parsed(reviewRunSchema, row.json) : null;
      return row && run ? { key: row.change_key as ChangeKey, run } : null;
    },
    putRun(key: ChangeKey, run: ReviewRun): void {
      putRun.run(run.threadId, key, run.startedAt, JSON.stringify(run));
    },
    findings: (key: ChangeKey): ReviewItem[] => rows(reviewItemSchema, findingsOf.all(key)),
    /** A thread's report replaces the one it made before. */
    replaceFindings: db.transaction((key: ChangeKey, threadId: string, items: ReviewItem[]) => {
      dropFindings.run(key, threadId);
      for (const item of items) putFinding.run(key, item.id, threadId, JSON.stringify(item));
    }),
    putFindings: db.transaction((key: ChangeKey, items: ReviewItem[]) => {
      for (const item of items) {
        const threadId = item.origin.kind === "bb" ? item.origin.threadId : "";
        putFinding.run(key, item.id, threadId, JSON.stringify(item));
      }
    }),
    drafts: (key: ChangeKey): Draft[] => rows(draftSchema, draftsOf.all(key)),
    draft,
    putDraft(key: ChangeKey, value: Draft): boolean {
      const before = draft(key, value.id);
      putDraft.run(key, value.id, value.createdAt, JSON.stringify(value));
      return JSON.stringify(before) !== JSON.stringify(value);
    },
    dropDraft: (key: ChangeKey, id: string): boolean => dropDraft.run(key, id).changes > 0,
    selected: (key: ChangeKey): string[] => selectedOf.all(key).map((row) => row.item_id),
    setSelected: db.transaction((key: ChangeKey, ids: readonly string[], on: boolean) => {
      let changes = 0;
      for (const id of ids) changes += (on ? select : unselect).run(key, id).changes;
      return changes > 0;
    }),
  };
}

export function openStore(bb: BbPluginApi) {
  const db: Database = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const getPlacement = db.prepare<[string], { json: string }>(
    `SELECT json FROM thread_placement WHERE thread_id = ?`,
  );
  const putPlacement = db.prepare(
    `INSERT INTO thread_placement (thread_id, json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (thread_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
  );
  const putCheckout = db.prepare(
    `INSERT INTO thread_checkout (thread_id, host_id, path) VALUES (?, ?, ?)
     ON CONFLICT (thread_id) DO UPDATE SET host_id = excluded.host_id, path = excluded.path`,
  );
  const dropCheckout = db.prepare(`DELETE FROM thread_checkout WHERE thread_id = ?`);
  const threadsAt = db.prepare<[string, string], { thread_id: string }>(
    `SELECT thread_id FROM thread_checkout WHERE host_id = ? AND path = ?`,
  );
  const getLocal = db.prepare<[string, string], { json: string }>(
    `SELECT json FROM local_facet WHERE host_id = ? AND path = ?`,
  );
  const putLocal = db.prepare(
    `INSERT INTO local_facet (host_id, path, json) VALUES (?, ?, ?)
     ON CONFLICT (host_id, path) DO UPDATE SET json = excluded.json`,
  );
  const getForge = db.prepare<[string], { json: string }>(
    `SELECT json FROM forge_facet WHERE change_key = ?`,
  );
  const putForge = db.prepare(
    `INSERT INTO forge_facet (change_key, json) VALUES (?, ?) ON CONFLICT (change_key) DO UPDATE SET json = excluded.json`,
  );
  const getChecks = db.prepare<[string], { json: string }>(
    `SELECT json FROM checks_facet WHERE change_key = ?`,
  );
  const putChecks = db.prepare(
    `INSERT INTO checks_facet (change_key, json) VALUES (?, ?) ON CONFLICT (change_key) DO UPDATE SET json = excluded.json`,
  );
  const getReadAs = db.prepare<[string, string], { read_as: string }>(
    `SELECT read_as FROM checkout_read_as WHERE host_id = ? AND path = ?`,
  );
  const putReadAs = db.prepare(
    `INSERT INTO checkout_read_as (host_id, path, read_as) VALUES (?, ?, ?)
     ON CONFLICT (host_id, path) DO UPDATE SET read_as = excluded.read_as`,
  );
  const dropReadAs = db.prepare(`DELETE FROM checkout_read_as WHERE host_id = ? AND path = ?`);
  const getBranch = db.prepare<[string], { branch: string | null }>(
    `SELECT branch FROM thread_branch WHERE thread_id = ?`,
  );
  const putBranch = db.prepare(
    `INSERT INTO thread_branch (thread_id, branch) VALUES (?, ?)
     ON CONFLICT (thread_id) DO UPDATE SET branch = excluded.branch`,
  );

  const local = (hostId: string, path: string): Facet<WorkspaceValue> => {
    const row = getLocal.get(hostId, path);
    return (row && parsed(localFacetSchema, row.json)) ?? EMPTY_FACET;
  };
  const forge = (key: ChangeKey): Facet<ForgeValue> => {
    const row = getForge.get(key);
    return (row && parsed(forgeFacetSchema, row.json)) ?? EMPTY_FACET;
  };
  const checks = (key: ChangeKey): Facet<ChecksValue> => {
    const row = getChecks.get(key);
    return (row && parsed(checksFacetSchema, row.json)) ?? EMPTY_FACET;
  };
  const placementRows = db.prepare<[], { host_id: string; path: string; json: string }>(
    `SELECT tc.host_id, tc.path, tp.json FROM thread_checkout tc
     JOIN thread_placement tp ON tp.thread_id = tc.thread_id
     GROUP BY tc.host_id, tc.path ORDER BY tc.host_id, tc.path`,
  );
  const getInbox = db.prepare<[string], { json: string }>(
    `SELECT json FROM inbox_facet WHERE login = ?`,
  );
  const putInbox = db.prepare(
    `INSERT INTO inbox_facet (login, json) VALUES (?, ?) ON CONFLICT (login) DO UPDATE SET json = excluded.json`,
  );
  const EMPTY_ROWS: SourceRows = { read: null, problem: null };
  const inbox = (login: string): SourceRows => {
    const row = getInbox.get(login);
    return (row && parsed(sourceRowsSchema, row.json)) ?? EMPTY_ROWS;
  };
  const sameRows = (before: SourceRows, after: SourceRows) =>
    JSON.stringify([before.read?.rows ?? null, before.problem]) ===
    JSON.stringify([after.read?.rows ?? null, after.problem]);

  const review = reviewTables(db);
  const guides = guideTables(db);
  const asks = askTables(db);
  const cutover = cutoverTables(db);

  const branch = (threadId: string): string | null => getBranch.get(threadId)?.branch ?? null;
  const readAs = (hostId: string, path: string): ReadAs =>
    getReadAs.get(hostId, path)?.read_as === "git" ? "git" : "auto";

  // Every setter stores its value and returns whether a reader would see a change.
  return {
    ...review,
    ...guides,
    ...asks,
    ...cutover,
    /** One placement per checkout the placement table knows, by host: what the review page lists. */
    checkouts(): Placement[] {
      return placementRows.all().flatMap((row) => {
        const value = parsed(threadPlacementSchema, row.json);
        return value?.state === "checkout" ? [value.placement] : [];
      });
    },
    inbox,
    setInbox(login: string, rows: SourceRows): boolean {
      const changed = !sameRows(inbox(login), rows);
      putInbox.run(login, JSON.stringify(rows));
      return changed;
    },
    placement(threadId: string): ThreadPlacement | null {
      const row = getPlacement.get(threadId);
      return row ? parsed(threadPlacementSchema, row.json) : null;
    },
    setPlacement(threadId: string, value: ThreadPlacement, now: number): boolean {
      const json = JSON.stringify(value);
      const changed = getPlacement.get(threadId)?.json !== json;
      putPlacement.run(threadId, json, now);
      if (value.state === "checkout")
        putCheckout.run(threadId, value.placement.hostId, value.placement.path);
      else dropCheckout.run(threadId);
      return changed;
    },
    /** Every thread last seen on this checkout. */
    threadsAt(hostId: string, path: string): string[] {
      return threadsAt.all(hostId, path).map((row) => row.thread_id);
    },
    local,
    setLocal(hostId: string, path: string, facet: Facet<WorkspaceValue>): boolean {
      const changed = !sameFacet(local(hostId, path), facet);
      putLocal.run(hostId, path, JSON.stringify(facet));
      return changed;
    },
    forge,
    setForge(key: ChangeKey, facet: Facet<ForgeValue>): boolean {
      const changed = !sameFacet(forge(key), facet);
      putForge.run(key, JSON.stringify(facet));
      return changed;
    },
    checks,
    setChecks(key: ChangeKey, facet: Facet<ChecksValue>): boolean {
      const changed = !sameFacet(checks(key), facet);
      putChecks.run(key, JSON.stringify(facet));
      return changed;
    },
    /** The thread's branch in its checkout, as last worked out. */
    branch,
    setBranch(threadId: string, name: string | null): boolean {
      const changed = branch(threadId) !== name;
      putBranch.run(threadId, name);
      return changed;
    },
    readAs,
    setReadAs(hostId: string, path: string, value: ReadAs): boolean {
      const changed = readAs(hostId, path) !== value;
      if (value === "git") putReadAs.run(hostId, path, "git");
      else dropReadAs.run(hostId, path);
      return changed;
    },
  };
}
