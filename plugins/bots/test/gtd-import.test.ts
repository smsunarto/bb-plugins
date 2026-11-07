import Database from "better-sqlite3";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { BOT_MIGRATIONS } from "../lib/bot-store";
import { importFromGtdSidebar } from "../lib/gtd-import";

function migrated() {
  const db = new Database(":memory:");
  for (const statement of BOT_MIGRATIONS) db.exec(statement);
  return db;
}

type Plugin = { id: string; enabled: boolean; status: string };

function fakeBb(db: Database.Database, plugins: Plugin[], exported: unknown) {
  const callRpc = vi.fn(async () => exported);
  const bb = {
    storage: { database: () => db },
    sdk: { plugins: { list: async () => ({ plugins }), callRpc } },
  } as unknown as BbPluginApi;
  return { bb, callRpc };
}

const GTD_RUNNING: Plugin = { id: "gtd-sidebar", enabled: true, status: "running" };
const EXPORT = {
  tables: {
    bots: [{ id: "bot_a", data: '{"id":"bot_a"}' }],
    bot_threads: [{ thread_id: "thr_1", bot_id: "bot_a" }],
    bot_state: [{ key: "memory:bot_a", data: '"remember"' }],
    thread_completion: [{ thread_id: "thr_1", completed_at: 5, reopened_at: null }],
    // A table the importer does not know is ignored, never interpolated.
    "bots; DROP TABLE bots": [{ id: "x" }],
  },
};

describe("GTD Sidebar import", () => {
  it("copies GTD's bot rows once and keeps rows Bots already has", async () => {
    const db = migrated();
    db.prepare("INSERT INTO bots(id,data) VALUES (?,?)").run("bot_a", '{"id":"bot_a","mine":1}');
    const { bb, callRpc } = fakeBb(db, [GTD_RUNNING], EXPORT);

    expect(await importFromGtdSidebar(bb)).toEqual({ kind: "done", rows: 3 });
    expect(callRpc).toHaveBeenCalledWith(
      expect.objectContaining({ pluginId: "gtd-sidebar", method: "retired_bots_export" }),
    );
    expect(db.prepare("SELECT data FROM bots WHERE id = 'bot_a'").get()).toEqual({
      data: '{"id":"bot_a","mine":1}',
    });
    expect(db.prepare("SELECT bot_id FROM bot_threads").all()).toEqual([{ bot_id: "bot_a" }]);
    expect(db.prepare("SELECT completed_at FROM thread_completion").get()).toEqual({
      completed_at: 5,
    });

    expect(await importFromGtdSidebar(bb)).toEqual({ kind: "nothing" });
    expect(callRpc).toHaveBeenCalledTimes(1);
  });

  it("finishes without GTD Sidebar and waits while GTD is installed but not serving", async () => {
    const absent = fakeBb(migrated(), [], EXPORT);
    expect(await importFromGtdSidebar(absent.bb)).toEqual({ kind: "nothing" });
    expect(await importFromGtdSidebar(absent.bb)).toEqual({ kind: "nothing" });
    expect(absent.callRpc).not.toHaveBeenCalled();

    const db = migrated();
    const starting = fakeBb(db, [{ ...GTD_RUNNING, status: "starting" }], EXPORT);
    expect(await importFromGtdSidebar(starting.bb)).toEqual({
      kind: "retry",
      reason: "GTD Sidebar is starting",
    });
    const disabled = fakeBb(db, [{ ...GTD_RUNNING, enabled: false }], EXPORT);
    expect((await importFromGtdSidebar(disabled.bb)).kind).toBe("retry");
    expect(starting.callRpc).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) AS n FROM bots").get()).toEqual({ n: 0 });
  });
});
