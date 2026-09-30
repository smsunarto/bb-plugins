import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { DevinTarget } from "../../shared/devin.ts";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;

/** An armed Cloud toggle older than this no longer applies. */
export const CLOUD_INTENT_TTL_MS = 10 * 60 * 1000;

/** Append-only (`bb.storage.migrate`): never edit or reorder a shipped entry. */
export const TARGET_MIGRATIONS = [
  `CREATE TABLE thread_target (
    thread_id TEXT PRIMARY KEY,
    target TEXT NOT NULL CHECK (target IN ('local', 'cloud'))
  )`,
  `CREATE TABLE cloud_intent (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    armed_at INTEGER NOT NULL
  )`,
];

/**
 * Which Devin a thread runs on. The Cloud toggle arms a one-shot intent, and a
 * thread's first command claims it and pins its target for good, because a
 * cloud session cannot move to the local agent or back.
 *
 * The store is synchronous on purpose: `deriveProviderOptions` sits on the
 * turn-submit path and cannot await. The plugin's own SQLite handle is the one
 * synchronous storage bb offers, and it survives server restarts.
 */
export function createTargetStore(db: Database, now: () => number = Date.now) {
  const selectTarget = db.prepare("SELECT target FROM thread_target WHERE thread_id = ?");
  const insertTarget = db.prepare("INSERT INTO thread_target (thread_id, target) VALUES (?, ?)");
  const deleteTarget = db.prepare("DELETE FROM thread_target WHERE thread_id = ?");
  const selectIntent = db.prepare("SELECT armed_at FROM cloud_intent WHERE id = 1");
  const upsertIntent = db.prepare(
    "INSERT INTO cloud_intent (id, armed_at) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET armed_at = excluded.armed_at",
  );
  const deleteIntent = db.prepare("DELETE FROM cloud_intent WHERE id = 1");

  function target(threadId: string): DevinTarget | null {
    const row = selectTarget.get(threadId) as { target: DevinTarget } | undefined;
    return row?.target ?? null;
  }

  function cloudArmed(): boolean {
    const row = selectIntent.get() as { armed_at: number } | undefined;
    if (row === undefined) return false;
    if (now() - row.armed_at < CLOUD_INTENT_TTL_MS) return true;
    deleteIntent.run();
    return false;
  }

  const claim = db.transaction((threadId: string): DevinTarget => {
    const pinned = target(threadId);
    if (pinned !== null) return pinned;
    const next: DevinTarget = cloudArmed() ? "cloud" : "local";
    deleteIntent.run();
    insertTarget.run(threadId, next);
    return next;
  });

  return {
    target,
    cloudArmed,
    /** The thread's target, pinning it on first sight. */
    claim: (threadId: string): DevinTarget => claim(threadId),
    setCloudArmed(armed: boolean): void {
      if (armed) upsertIntent.run(now());
      else deleteIntent.run();
    },
    forget(threadId: string): void {
      deleteTarget.run(threadId);
    },
  };
}

export type TargetStore = ReturnType<typeof createTargetStore>;

const stores = new WeakMap<BbPluginApi, TargetStore>();

export function setupTargetStore(bb: BbPluginApi): TargetStore {
  const db = bb.storage.database();
  bb.storage.migrate(db, TARGET_MIGRATIONS);
  const store = createTargetStore(db);
  stores.set(bb, store);
  return store;
}

export function getTargetStore(bb: BbPluginApi): TargetStore {
  const store = stores.get(bb);
  if (store === undefined) throw new Error("The Devin target store is not initialized.");
  return store;
}
