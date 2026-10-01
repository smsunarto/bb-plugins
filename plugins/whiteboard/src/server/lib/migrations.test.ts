import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type BetterSqlite3 from "better-sqlite3";
import { expect, it } from "vitest";
import { MIGRATIONS, migrate } from "./migrations.ts";

const columns = (db: BetterSqlite3.Database, table: string) =>
  db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((column) => {
      const { name, type, notnull, pk } = column as {
        name: string;
        type: string;
        notnull: number;
        pk: number;
      };
      return { name, type, notnull, pk };
    });

it("creates the plugin tables WP2 and WP8 read, and is idempotent across loads", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "whiteboard" });
  migrate(bb);
  migrate(bb);
  const db = bb.storage.database();
  expect(columns(db, "repository_hosts")).toEqual([
    { name: "repository_id", type: "TEXT", notnull: 0, pk: 1 },
    { name: "host_id", type: "TEXT", notnull: 1, pk: 0 },
  ]);
  expect(columns(db, "session_threads")).toEqual([
    { name: "session_id", type: "TEXT", notnull: 1, pk: 1 },
    { name: "thread_id", type: "TEXT", notnull: 1, pk: 2 },
  ]);
  db.prepare("INSERT INTO session_threads VALUES(?,?)").run("s1", "t1");

  const reloaded = await harness.lifecycle.reload((next) => migrate(next));
  expect(
    reloaded.bb.storage
      .database()
      .prepare("SELECT session_id, thread_id FROM session_threads")
      .all(),
  ).toEqual([{ session_id: "s1", thread_id: "t1" }]);
  await reloaded.harness.dispose();
});

it("refuses an edited shipped statement (append-only)", () => {
  const { bb } = createFakePluginHost({ pluginId: "whiteboard" });
  migrate(bb);
  expect(() =>
    bb.storage.migrate(bb.storage.database(), [`${MIGRATIONS[0]} -- edited`, MIGRATIONS[1]!]),
  ).toThrow();
});
