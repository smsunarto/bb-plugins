import { randomUUID } from "node:crypto";
import { DatabaseSync as NodeDatabaseSync } from "node:sqlite";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrate } from "./migrations.ts";
import {
  BB_PLUGIN_DATABASE,
  DatabaseSync,
  installDatabase,
  installDatabaseOpener,
} from "./sqlite.ts";
import { ACTIVITY_TTL_MS } from "./vendor/review/src/review-api/activity.ts";
import { type ReviewProviders, ReviewStore } from "./vendor/review/src/review-api/store.ts";

type Db = InstanceType<typeof NodeDatabaseSync>;

const providers: ReviewProviders = {
  validatePins: async () => {},
  validateSource: async () => {},
  validateResource: async () => {},
};
const pins = { repositoryId: "repo", base: "base-commit", head: "head-commit" };

const outcome = (run: () => unknown) => {
  try {
    return { value: run() };
  } catch (error) {
    const { name, message, code } = error as Error & { code?: string };
    return { error: { name, message, code } };
  }
};

/** The behaviors upstream can observe, each run on a fresh database. */
const scenarios: Record<string, (db: Db) => unknown> = {
  "foreign keys are on": (db) => ({ ...db.prepare("PRAGMA foreign_keys").get() }),
  "a BLOB reads back as Uint8Array": (db) => {
    db.exec("CREATE TABLE t(b BLOB NOT NULL)");
    db.prepare("INSERT INTO t VALUES(?)").run(new Uint8Array([1, 2, 3]));
    const value = db.prepare("SELECT b FROM t").get()!.b as Uint8Array;
    return { prototype: Object.getPrototypeOf(value) === Uint8Array.prototype, bytes: [...value] };
  },
  "get and all on a write run it and return nothing": (db) => {
    db.exec("CREATE TABLE t(a)");
    const got = db.prepare("INSERT INTO t VALUES(1)").get();
    const all = db.prepare("INSERT INTO t VALUES(2)").all();
    return { got, all, rows: db.prepare("SELECT count(*) n FROM t").get()!.n };
  },
  "run reports changes and the rowid": (db) => {
    db.exec("CREATE TABLE t(a)");
    return { ...db.prepare("INSERT INTO t VALUES(?)").run(5) };
  },
  "binding undefined throws": (db) =>
    // @ts-expect-error -- deliberately unbindable: upstream must never rely on it
    outcome(() => db.prepare("SELECT ? v").get(undefined)),
  "binding a boolean throws": (db) =>
    // @ts-expect-error -- deliberately unbindable: upstream must never rely on it
    outcome(() => db.prepare("SELECT ?, ? v").get(1, true)),
  "named parameters bind": (db) => ({ ...db.prepare("SELECT :a v").get({ a: 1 }) }),
  "a syntax error throws": (db) => outcome(() => db.exec("SELEC 1")),
  "a unique violation throws": (db) => {
    db.exec("CREATE TABLE t(a PRIMARY KEY)");
    db.prepare("INSERT INTO t VALUES(1)").run();
    return outcome(() => db.prepare("INSERT INTO t VALUES(1)").run());
  },
  "a foreign key violation throws": (db) => {
    db.exec("CREATE TABLE p(id PRIMARY KEY); CREATE TABLE c(p REFERENCES p(id))");
    return outcome(() => db.prepare("INSERT INTO c VALUES('missing')").run());
  },
  "iterate yields every row": (db) =>
    [...db.prepare("SELECT 1 a UNION SELECT 2").iterate()].map((row) => row.a),
  "a missing row is undefined": (db) => db.prepare("SELECT 1 WHERE 0").get(),
  "a closed database refuses use": (db) => {
    db.close();
    return outcome(() => db.prepare("SELECT 1"));
  },
};

afterEach(() => {
  vi.useRealTimers();
});

describe("DatabaseSync over better-sqlite3", () => {
  it.each(Object.keys(scenarios))("matches node:sqlite: %s", (name) => {
    installDatabaseOpener((path, options) => new BetterSqlite3(path, options));
    const scenario = scenarios[name]!;
    const expected = scenario(new NodeDatabaseSync(":memory:"));
    expect(scenario(new DatabaseSync(":memory:"))).toEqual(expected);
  });

  it("pins the node:sqlite results the adapter reproduces", () => {
    const db = new NodeDatabaseSync(":memory:");
    expect(scenarios["a BLOB reads back as Uint8Array"]!(db)).toEqual({
      prototype: true,
      bytes: [1, 2, 3],
    });
    expect(scenarios["binding undefined throws"]!(db)).toEqual({
      error: {
        name: "TypeError",
        message: "Provided value cannot be bound to SQLite parameter 1.",
        code: "ERR_INVALID_ARG_TYPE",
      },
    });
    expect(scenarios["a foreign key violation throws"]!(new NodeDatabaseSync(":memory:"))).toEqual({
      error: { name: "Error", message: "FOREIGN KEY constraint failed", code: "ERR_SQLITE_ERROR" },
    });
  });

  it("turns foreign keys on for a handle that has them off", () => {
    const handle = new BetterSqlite3(":memory:");
    handle.pragma("foreign_keys = OFF");
    const db = new DatabaseSync(installDatabase(handle));
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(handle.pragma("foreign_keys", { simple: true })).toBe(1);
    handle.close();
  });

  it("opens bb's handle only by the path installDatabase returns", () => {
    const handle = new BetterSqlite3(":memory:");
    expect(installDatabase(handle)).toBe("bb-plugin-database");

    expect(() => new DatabaseSync(":memory:")).toThrow(
      `whiteboard: bb's plugin database is installed, so the store opens "bb-plugin-database", not ":memory:".`,
    );
    const db = new DatabaseSync(BB_PLUGIN_DATABASE);
    db.exec("CREATE TABLE t(a)");
    expect(handle.prepare("SELECT name FROM sqlite_master").pluck().all()).toEqual(["t"]);
    handle.close();
  });

  it("refuses to open before a database is installed", async () => {
    vi.resetModules();
    const fresh = await import("./sqlite.ts");
    expect(() => new fresh.DatabaseSync("ignored")).toThrow(
      "whiteboard: no database installed. Call installDatabase(bb.storage.database()) before constructing the store.",
    );
  });
});

/** The production wiring: plugin migrations, then the store on bb's own handle. */
function storeOnBb() {
  const { bb, harness } = createFakePluginHost({ pluginId: "whiteboard" });
  migrate(bb);
  const db = bb.storage.database();
  return { bb, harness, db, store: new ReviewStore(installDatabase(db), providers) };
}

describe("ReviewStore on bb.storage.database()", () => {
  it("creates upstream's tables beside the plugin tables", async () => {
    const { db, store, harness } = storeOnBb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .pluck()
      .all();
    expect(tables).toEqual(
      expect.arrayContaining([
        "authoring_sessions",
        "comparison_stats",
        "legacy_imports",
        "receipts",
        "repositories",
        "repository_hosts",
        "resources",
        "review_attention",
        "review_coverage",
        "reviews",
        "session_threads",
        "versions",
      ]),
    );
    await store.close();
    await harness.dispose();
  });

  it("replays a receipt deep-equal, across a restart, and rejects reuse with different input", async () => {
    const { db, store, harness } = storeOnBb();
    const command = {
      commandId: randomUUID(),
      operation: { type: "create", title: "Replay", pins },
    };
    const first = await store.execute(command);
    expect(first).toMatchObject({ version: 0 });
    expect(await store.execute(command)).toEqual(first);

    await store.close();
    expect(db.open).toBe(true);
    const restarted = new ReviewStore(BB_PLUGIN_DATABASE, providers);
    expect(await restarted.execute(command)).toEqual(first);
    expect(restarted.list()).toHaveLength(1);
    await expect(
      restarted.execute({ ...command, operation: { ...command.operation, title: "Other" } }),
    ).rejects.toMatchObject({
      status: 409,
      message: "Command ID was already used for different input.",
    });
    await restarted.close();
    await harness.dispose();
  });

  it("holds a document lease for exactly 180 s without writes", async () => {
    vi.useFakeTimers();
    const { store, harness } = storeOnBb();
    const { reviewId } = await store.execute({
      commandId: randomUUID(),
      operation: { type: "create", title: "Lease", pins },
    });
    const owner = randomUUID();
    const other = randomUUID();
    const rename = (leaseId: string, title: string) =>
      store.execute({
        commandId: randomUUID(),
        leaseId,
        operation: { type: "rename", reviewId, title },
      });

    expect(ACTIVITY_TTL_MS).toBe(180_000);
    store.activity.update(reviewId, { action: "begin", leaseId: owner });
    vi.advanceTimersByTime(179_999);
    await expect(rename(other, "Taken")).rejects.toMatchObject({
      status: 409,
      message:
        "This review is being authored by another session. Wait for it to finish or expire, then begin your own session.",
    });
    vi.advanceTimersByTime(1);
    expect(store.activity.read(reviewId)).toEqual({ workingCount: 0, expiresAt: null });
    store.activity.update(reviewId, { action: "begin", leaseId: other });
    expect(await rename(other, "Mine")).toMatchObject({ version: 1 });
    await store.close();
    await harness.dispose();
  });

  it("enforces foreign keys: children need parents, and delete removes a review's rows", async () => {
    const { db, store, harness } = storeOnBb();
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(() =>
      store.putResource("res-1", "unregistered", "image", "image/png", new Uint8Array([1])),
    ).toThrow("FOREIGN KEY constraint failed");

    const { reviewId } = await store.execute({
      commandId: randomUUID(),
      operation: { type: "create", title: "Doomed", pins },
    });
    await store.execute({
      commandId: randomUUID(),
      operation: { type: "attention", reviewId, action: "view" },
    });
    expect(() => db.prepare("DELETE FROM reviews WHERE id=?").run(reviewId)).toThrow(
      "FOREIGN KEY constraint failed",
    );
    const count = (table: string) =>
      db.prepare(`SELECT count(*) FROM ${table} WHERE review_id=?`).pluck().get(reviewId);
    expect([count("versions"), count("review_attention")]).toEqual([1, 1]);

    await store.execute({ commandId: randomUUID(), operation: { type: "delete", reviewId } });
    expect([count("versions"), count("review_attention")]).toEqual([0, 0]);
    expect(db.prepare("SELECT count(*) FROM reviews WHERE id=?").pluck().get(reviewId)).toBe(0);
    await store.close();
    await harness.dispose();
  });

  it("returns BLOBs as Uint8Array and rejects a reused resource ID with other bytes", async () => {
    const { store, harness } = storeOnBb();
    const repository = store.registerRepository("/work/app");
    store.putResource(
      "res-1",
      repository.id,
      "image",
      "image/png",
      new Uint8Array([137, 80, 78, 71]),
    );
    const { data } = store.resource("res-1");
    expect(Object.getPrototypeOf(data)).toBe(Uint8Array.prototype);
    expect([...data]).toEqual([137, 80, 78, 71]);
    expect(
      store.putResource(
        "res-1",
        repository.id,
        "image",
        "image/png",
        new Uint8Array([137, 80, 78, 71]),
      ),
    ).toEqual({
      id: "res-1",
      kind: "image",
      mimeType: "image/png",
    });
    expect(() =>
      store.putResource("res-1", repository.id, "image", "image/png", new Uint8Array([0])),
    ).toThrow("Resource ID was already used for different content.");
    await store.close();
    await harness.dispose();
  });

  it("detaches from bb's handle on close and refuses later use", async () => {
    const { db, store, harness } = storeOnBb();
    await store.close();
    expect(db.open).toBe(true);
    expect(() => store.list()).toThrow("database is not open");
    await harness.dispose();
    expect(db.open).toBe(false);
  });
});
