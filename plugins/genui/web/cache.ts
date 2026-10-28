// A bounded cache of web lookups in the plugin's own SQLite database, so a UI
// rendered again (a reload, another device, the same search in a later reply)
// doesn't fetch again. Least recently used entries go first once the cache
// passes its size; expired entries are kept for conditional revalidation
// until then.
import type Database from "better-sqlite3";

/** Append-only migrations for `bb.storage.migrate`. */
export const CACHE_MIGRATIONS: readonly string[] = [
  `CREATE TABLE web_cache (
    key TEXT PRIMARY KEY,
    body BLOB NOT NULL,
    meta TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER NOT NULL
  );
  CREATE INDEX web_cache_used ON web_cache (used_at);`,
];

/** Per-row bookkeeping counted against the size cap, so tiny rows can't pile up unbounded. */
const ROW_OVERHEAD = 256;

export interface CacheEntry {
  readonly body: Buffer;
  /** JSON the writer stored beside the body (MIME type, validators, credits). */
  readonly meta: string;
  readonly expired: boolean;
}

interface Row {
  body: Buffer;
  meta: string;
  expires_at: number;
}

export class WebCache {
  constructor(
    private readonly database: () => Database.Database,
    private readonly maxBytes: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): CacheEntry | null {
    const db = this.database();
    const row = db.prepare("SELECT body, meta, expires_at FROM web_cache WHERE key = ?").get(key) as Row | undefined;
    if (row === undefined) return null;
    const now = this.now();
    db.prepare("UPDATE web_cache SET used_at = ? WHERE key = ?").run(now, key);
    return { body: row.body, meta: row.meta, expired: row.expires_at <= now };
  }

  put(key: string, body: Buffer, meta: string, ttlMs: number): void {
    const db = this.database();
    const now = this.now();
    db.prepare(
      `INSERT INTO web_cache (key, body, meta, bytes, expires_at, used_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET body = excluded.body, meta = excluded.meta, bytes = excluded.bytes,
         expires_at = excluded.expires_at, used_at = excluded.used_at`,
    ).run(key, body, meta, body.length + meta.length + ROW_OVERHEAD, now + ttlMs, now);
    this.evict(db);
  }

  /** Extends an entry the origin confirmed unchanged (HTTP 304). */
  renew(key: string, meta: string, ttlMs: number): void {
    const now = this.now();
    this.database()
      .prepare("UPDATE web_cache SET meta = ?, expires_at = ?, used_at = ? WHERE key = ?")
      .run(meta, now + ttlMs, now, key);
  }

  /** Total bytes held, as counted against the cap. */
  size(): number {
    const row = this.database().prepare("SELECT COALESCE(SUM(bytes), 0) AS total FROM web_cache").get() as { total: number };
    return row.total;
  }

  /** Drops least recently used rows until the cache is back under 80% of its cap. */
  private evict(db: Database.Database): void {
    let total = this.size();
    if (total <= this.maxBytes) return;
    const target = this.maxBytes * 0.8;
    const oldest = db.prepare("SELECT key, bytes FROM web_cache ORDER BY used_at ASC LIMIT 64");
    const remove = db.prepare("DELETE FROM web_cache WHERE key = ?");
    while (total > target) {
      const rows = oldest.all() as { key: string; bytes: number }[];
      if (rows.length === 0) return;
      db.transaction(() => {
        for (const row of rows) {
          if (total <= target) break;
          remove.run(row.key);
          total -= row.bytes;
        }
      })();
    }
  }
}
