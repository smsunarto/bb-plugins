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
  facetSchema,
  forgeValueSchema,
  placementSchema,
  workspaceValueSchema,
  type Facet,
  type ForgeValue,
  type Placement,
  type WorkspaceValue,
} from "../core/change.ts";
import type { ChangeKey } from "../core/ids.ts";
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
  const branch = (threadId: string): string | null => getBranch.get(threadId)?.branch ?? null;
  const readAs = (hostId: string, path: string): ReadAs =>
    getReadAs.get(hostId, path)?.read_as === "git" ? "git" : "auto";

  // Every setter stores its value and returns whether a reader would see a change.
  return {
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
