/**
 * Last-good facets and thread placements in the plugin's SQLite database,
 * so every client, a phone included, gets "Read 12 min ago" even after a
 * restart. Facets are normalized by their source: a checkout's local facet
 * by (host, path), a forge facet by ChangeKey, so two threads or two hosts
 * on one branch share one pull request read.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  EMPTY_FACET,
  type Facet,
  type ForgeValue,
  type LocalValue,
  type Placement,
  type ThreadChange,
} from "../core/change.ts";
import { changeKeyOf, type ChangeKey } from "../core/ids.ts";

/** Where a thread's Change comes from, or why it has none. */
export type ThreadPlacement =
  | { state: "none"; reason: string }
  | { state: "checkout"; placement: Placement };

type Database = ReturnType<BbPluginApi["storage"]["database"]>;

const MIGRATIONS = [
  `CREATE TABLE thread_placement (thread_id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE local_facet (host_id TEXT NOT NULL, path TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (host_id, path))`,
  `CREATE TABLE forge_facet (change_key TEXT PRIMARY KEY, json TEXT NOT NULL)`,
];

export type Store = ReturnType<typeof openStore>;

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

  const placement = (threadId: string): ThreadPlacement | null => {
    const row = getPlacement.get(threadId);
    return row ? (JSON.parse(row.json) as ThreadPlacement) : null;
  };
  const local = (hostId: string, path: string): Facet<LocalValue> => {
    const row = getLocal.get(hostId, path);
    return row ? (JSON.parse(row.json) as Facet<LocalValue>) : EMPTY_FACET;
  };
  const forge = (key: ChangeKey): Facet<ForgeValue> => {
    const row = getForge.get(key);
    return row ? (JSON.parse(row.json) as Facet<ForgeValue>) : EMPTY_FACET;
  };

  return {
    placement,
    setPlacement(threadId: string, value: ThreadPlacement, now: number) {
      putPlacement.run(threadId, JSON.stringify(value), now);
    },
    local,
    setLocal(hostId: string, path: string, facet: Facet<LocalValue>) {
      putLocal.run(hostId, path, JSON.stringify(facet));
    },
    forge,
    setForge(key: ChangeKey, facet: Facet<ForgeValue>) {
      putForge.run(key, JSON.stringify(facet));
    },
    /** One thread's Change assembled from its placement and the facets it points at. */
    threadChange(threadId: string): ThreadChange {
      const where = placement(threadId);
      if (!where) return { state: "pending" };
      if (where.state === "none") return where;
      const localFacet = local(where.placement.hostId, where.placement.path);
      const key = keyOf(where.placement, localFacet);
      return {
        state: "checkout",
        placement: where.placement,
        key,
        local: localFacet,
        forge: key ? forge(key) : EMPTY_FACET,
      };
    },
  };
}

/** The ChangeKey a checkout's last read implies, or null before its first read. */
export function keyOf(placement: Placement, local: Facet<LocalValue>): ChangeKey | null {
  const value = local.read?.value;
  return value
    ? changeKeyOf(
        { hostId: placement.hostId, commonDir: value.commonDir, branch: value.branch },
        value.github,
      )
    : null;
}
