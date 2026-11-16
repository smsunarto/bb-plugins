import { expect, test } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { ChangeKey } from "../core/ids.ts";
import type { ChangeRow, SourceRows } from "../core/review.ts";
import { MIGRATIONS, openStore } from "./store.ts";

/** The migrations before pins left: what a database from that build has run. */
const BEFORE_PINS_LEFT = MIGRATIONS.slice(0, MIGRATIONS.indexOf("DROP TABLE IF EXISTS pin"));

const row = (number: number, pinned: boolean): ChangeRow & { pinned?: true } => ({
  key: `gh:acme/api:acme:b${number}` as ChangeKey,
  repo: "acme/api",
  title: `Change "${number}", "pinned":true in its title`,
  branch: `b${number}`,
  baseRef: "main",
  number,
  url: `https://github.com/acme/api/pull/${number}`,
  author: "scott",
  state: "open",
  mine: true,
  asked: false,
  // The old build wrote the mark right after `asked`.
  ...(pinned ? { pinned: true as const } : {}),
  stack: null,
  hostId: null,
  line: "",
  chips: [],
  sort: 5,
  updatedAt: null,
});

/** A database as the build before this one left it, with `pins` pins and an inbox that marks them. */
function oldDatabase(pins: number) {
  const { bb } = createFakePluginHost({ pluginId: "source-control" });
  const db = bb.storage.database();
  bb.storage.migrate(db, BEFORE_PINS_LEFT);
  for (let n = 1; n <= pins; n++)
    db.prepare(`INSERT INTO pin (pr_key, json, created_at) VALUES (?, ?, ?)`).run(
      `acme/api#${n}`,
      JSON.stringify({ owner: "acme", repo: "api", number: n }),
      n,
    );
  const rows = [row(1, pins >= 1), row(2, false)];
  const inbox: SourceRows = { read: { rows, at: 1 }, problem: null };
  db.prepare(`INSERT INTO inbox_facet (login, json) VALUES (?, ?)`).run(
    "scott",
    JSON.stringify(inbox),
  );
  db.prepare(`INSERT INTO viewer (repo, login) VALUES (?, ?)`).run("acme/api", "scott");
  return { bb, db };
}

type Db = ReturnType<typeof oldDatabase>["db"];
const hasPinTable = (db: Db) =>
  db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pin'`).get() !==
  undefined;

test.each([
  ["has pins", 2],
  ["has an empty pin table", 0],
])("a database that %s drops the table, keeps its inbox and everything else", (_, pins) => {
  const { bb, db } = oldDatabase(pins);
  expect(hasPinTable(db)).toBe(true);
  const store = openStore(bb);
  expect(hasPinTable(db)).toBe(false);
  const rows = store.inbox("scott").read?.rows ?? [];
  expect(rows.map((each) => [each.number, "pinned" in each])).toEqual([
    [1, false],
    [2, false],
  ]);
  // A title that quotes the mark is left as it was.
  expect(rows[0]!.title).toBe(`Change "1", "pinned":true in its title`);
  expect(db.prepare(`SELECT login FROM viewer WHERE repo = ?`).get("acme/api")).toEqual({
    login: "scott",
  });
  // Opening again runs nothing new; running the two statements again changes nothing.
  openStore(bb);
  for (const statement of MIGRATIONS.slice(BEFORE_PINS_LEFT.length)) db.exec(statement);
  expect(store.inbox("scott").read?.rows.map((each) => each.number)).toEqual([1, 2]);
});

test("a fresh database ends without a pin table", () => {
  const { bb } = createFakePluginHost({ pluginId: "source-control" });
  const store = openStore(bb);
  expect(hasPinTable(bb.storage.database())).toBe(false);
  expect(store.inbox("scott")).toEqual({ read: null, problem: null });
  openStore(bb);
  expect(hasPinTable(bb.storage.database())).toBe(false);
});
