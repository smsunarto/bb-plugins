import type BetterSqlite3 from "better-sqlite3";
import type * as NodeSqlite from "node:sqlite";

/**
 * The `node:sqlite` surface `store.ts` and `activity.ts` use, over the bb
 * plugin database (design §3.10). The engine installs bb's handle with
 * `useDatabase` before it constructs the store, and the constructor then
 * ignores its path. Differences from better-sqlite3 that upstream can observe
 * are normalized here:
 *
 * - `foreign_keys` is on, as `node:sqlite` enables it by default.
 * - BLOB columns read back as `Uint8Array`, not `Buffer`.
 * - `get`/`all` on a statement that returns no rows yield `undefined`/`[]`.
 * - Positional values other than null, numbers, bigints, strings and byte
 *   views (`undefined`, booleans) throw `node:sqlite`'s TypeError.
 * - SQLite errors are plain `Error`s with code `ERR_SQLITE_ERROR` and the
 *   same message. Upstream's 500 envelope names the code
 *   ("Review operation failed (ERR_SQLITE_ERROR)…").
 * - Closing a borrowed handle only detaches it. bb owns and closes it.
 *
 * Not reproduced: `node:sqlite` binds NULL for missing parameters and ignores
 * SQL after the first statement in `prepare`. better-sqlite3 throws for both.
 * Upstream does neither.
 */
export type DatabaseSync = NodeSqlite.DatabaseSync;

/** Opens a database the adapter owns and closes. Tests use it; the plugin never does. */
export type DatabaseOpener = (
  path: string,
  options: { timeout?: number },
) => BetterSqlite3.Database;

type Source =
  | { kind: "borrowed"; handle: BetterSqlite3.Database }
  | { kind: "owned"; open: DatabaseOpener };

let source: Source | undefined;

/** Install the bb handle that every later `new DatabaseSync(...)` wraps. */
export function useDatabase(handle: BetterSqlite3.Database): void {
  source = { kind: "borrowed", handle };
}

/** Open a fresh database per `new DatabaseSync(path)` instead. For specs on real better-sqlite3. */
export function useDatabaseOpener(open: DatabaseOpener): void {
  source = { kind: "owned", open };
}

type Row = Record<string, NodeSqlite.SQLOutputValue>;

function notOpen(): Error {
  return Object.assign(new Error("database is not open"), { code: "ERR_INVALID_STATE" });
}

const BINDABLE = new Set(["number", "bigint", "string"]);

/** A leading plain object holds named parameters, as in both libraries. */
function bindable(params: unknown[]): unknown[] {
  const named =
    typeof params[0] === "object" && params[0] !== null && !ArrayBuffer.isView(params[0]);
  params.forEach((value, index) => {
    if (named && index === 0) return;
    if (value === null || BINDABLE.has(typeof value) || ArrayBuffer.isView(value)) return;
    throw Object.assign(
      new TypeError(`Provided value cannot be bound to SQLite parameter ${index + 1}.`),
      { code: "ERR_INVALID_ARG_TYPE" },
    );
  });
  return params;
}

/** Rethrow better-sqlite3's SqliteError in node:sqlite's shape. */
function sqlite<T>(call: () => T): T {
  try {
    return call();
  } catch (error) {
    if (error instanceof Error && error.name === "SqliteError")
      throw Object.assign(new Error(error.message, { cause: error }), { code: "ERR_SQLITE_ERROR" });
    throw error;
  }
}

function toRow(row: unknown): Row | undefined {
  if (!row) return undefined;
  const out = row as Row;
  for (const key of Object.keys(out)) {
    const value = out[key];
    if (Buffer.isBuffer(value)) out[key] = new Uint8Array(value);
  }
  return out;
}

class Statement {
  readonly #database: Database;
  readonly #statement: BetterSqlite3.Statement;

  constructor(database: Database, statement: BetterSqlite3.Statement) {
    this.#database = database;
    this.#statement = statement;
  }

  run(...params: unknown[]): NodeSqlite.StatementResultingChanges {
    this.#database.assertOpen();
    return sqlite(() => this.#statement.run(...bindable(params)));
  }

  get(...params: unknown[]): Row | undefined {
    if (!this.#statement.reader) {
      this.run(...params);
      return undefined;
    }
    this.#database.assertOpen();
    return toRow(sqlite(() => this.#statement.get(...bindable(params))));
  }

  all(...params: unknown[]): Row[] {
    if (!this.#statement.reader) {
      this.run(...params);
      return [];
    }
    this.#database.assertOpen();
    return sqlite(() => this.#statement.all(...bindable(params))).map((row) => toRow(row)!);
  }

  /** Materialized first: better-sqlite3 locks the connection while a cursor is open. */
  iterate(...params: unknown[]): IterableIterator<Row> {
    return this.all(...params)[Symbol.iterator]();
  }
}

class Database {
  readonly #handle: BetterSqlite3.Database;
  readonly #owned: boolean;
  #open = true;

  constructor(path: string, options?: NodeSqlite.DatabaseSyncOptions) {
    if (!source)
      throw new Error(
        "whiteboard: no database installed. Call useDatabase(bb.storage.database()) before constructing the store.",
      );
    this.#owned = source.kind === "owned";
    this.#handle =
      source.kind === "borrowed"
        ? source.handle
        : source.open(path, options?.timeout === undefined ? {} : { timeout: options.timeout });
    sqlite(() => this.#handle.exec("PRAGMA foreign_keys=ON"));
  }

  assertOpen(): void {
    if (!this.#open) throw notOpen();
  }

  exec(sql: string): void {
    this.assertOpen();
    sqlite(() => this.#handle.exec(sql));
  }

  prepare(sql: string): Statement {
    this.assertOpen();
    return new Statement(
      this,
      sqlite(() => this.#handle.prepare(sql)),
    );
  }

  close(): void {
    this.assertOpen();
    this.#open = false;
    if (this.#owned) this.#handle.close();
  }
}

export const DatabaseSync = Database as unknown as typeof NodeSqlite.DatabaseSync;
