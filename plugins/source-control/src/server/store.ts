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
  workspaceValueSchema,
  type ChecksValue,
  type Facet,
  type ForgeValue,
  type Placement,
  type WorkspaceValue,
} from "../core/change.ts";
import type { ChangeKey } from "../core/ids.ts";
import {
  draftSchema,
  forgeThreadSchema,
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

  return {
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

  const branch = (threadId: string): string | null => getBranch.get(threadId)?.branch ?? null;
  const readAs = (hostId: string, path: string): ReadAs =>
    getReadAs.get(hostId, path)?.read_as === "git" ? "git" : "auto";

  // Every setter stores its value and returns whether a reader would see a change.
  return {
    ...review,
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
