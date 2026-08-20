import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import plugin from "../server.ts";

interface LifecycleHandlers {
  settle(input: { threadId: string }): Promise<{ ok: boolean }>;
  unsettle(input: { threadId: string }): Promise<{ ok: boolean }>;
  listSettledThreads(): Promise<{
    threads: Array<{ id: string; settledAt: number }>;
  }>;
}

function archivedThread(id: string) {
  return {
    id,
    projectId: "proj_1",
    title: "Legacy settled thread",
    titleFallback: null,
    parentThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "codex",
    status: "idle",
    hasPendingInteraction: false,
    pinnedAt: null,
    activity: {
      activeWorkflowCount: 0,
      activeBackgroundAgentCount: 0,
      activeBackgroundCommandCount: 0,
      activePlanModeCount: 0,
      activeGoalCount: 0,
    },
    createdAt: 100,
    updatedAt: 200,
    lastReadAt: 200,
    latestAttentionAt: 200,
  };
}

function createHarness(archived = [archivedThread("legacy")]) {
  const db = new Database(":memory:");
  const archiveCalls: string[] = [];
  const unarchiveCalls: string[] = [];
  const publishes: string[] = [];
  let handlers: LifecycleHandlers | undefined;

  const bb = {
    settings: { define() {} },
    storage: {
      database: () => db,
      migrate(database: Database.Database, statements: readonly string[]) {
        for (const statement of statements) database.exec(statement);
      },
    },
    realtime: {
      publish(channel: string) {
        publishes.push(channel);
      },
    },
    rpc: {
      register(_contract: unknown, registered: unknown) {
        handlers = registered as LifecycleHandlers;
      },
    },
    sdk: {
      providers: { list: async () => [] },
      threads: {
        archive: async ({ threadId }: { threadId: string }) => {
          archiveCalls.push(threadId);
          return { archivedThreadIds: [threadId] };
        },
        unarchive: async ({ threadId }: { threadId: string }) => {
          unarchiveCalls.push(threadId);
          return {};
        },
        list: async () => archived,
        output: async () => ({ output: "" }),
      },
    },
    log: { warn() {} },
    events: { on() {} },
  };

  plugin(bb as unknown as BbPluginApi);
  assert.ok(handlers);
  return { archiveCalls, db, handlers, publishes, unarchiveCalls };
}

describe("settled lifecycle RPCs", () => {
  it("settle writes one lifecycle row and does not archive", async () => {
    const { archiveCalls, db, handlers, publishes } = createHarness();

    assert.deepEqual(await handlers.settle({ threadId: "thr_1" }), { ok: true });

    assert.deepEqual(archiveCalls, []);
    assert.deepEqual(publishes, ["lifecycle"]);
    assert.deepEqual(
      db
        .prepare(
          `SELECT thread_id, snoozed_until, snoozed_at, archived_thread_ids
             FROM thread_lifecycle
            WHERE thread_id = ?`,
        )
        .get("thr_1"),
      {
        thread_id: "thr_1",
        snoozed_until: null,
        snoozed_at: null,
        archived_thread_ids: null,
      },
    );
    const settledAt = db
      .prepare(`SELECT settled_at FROM thread_lifecycle WHERE thread_id = ?`)
      .pluck()
      .get("thr_1");
    assert.equal(typeof settledAt, "number");
  });

  it("unsettle clears the row and restores every legacy archived id", async () => {
    const { db, handlers, unarchiveCalls } = createHarness();
    db.prepare(
      `INSERT INTO thread_lifecycle
         (thread_id, settled_at, snoozed_until, snoozed_at, archived_thread_ids)
       VALUES (?, ?, NULL, NULL, ?)`,
    ).run("legacy", 1_000, JSON.stringify(["legacy", "legacy-child"]));

    assert.deepEqual(await handlers.unsettle({ threadId: "legacy" }), { ok: true });

    assert.deepEqual(unarchiveCalls, ["legacy", "legacy-child"]);
    assert.equal(
      db.prepare(`SELECT 1 FROM thread_lifecycle WHERE thread_id = ?`).get("legacy"),
      undefined,
    );
  });

  it("unsettle does not touch bb's archive when the row has no legacy ids", async () => {
    const { db, handlers, unarchiveCalls } = createHarness();
    db.prepare(
      `INSERT INTO thread_lifecycle
         (thread_id, settled_at, snoozed_until, snoozed_at, archived_thread_ids)
       VALUES (?, ?, NULL, NULL, NULL)`,
    ).run("current", 1_000);

    await handlers.unsettle({ threadId: "current" });

    assert.deepEqual(unarchiveCalls, []);
    assert.equal(
      db.prepare(`SELECT 1 FROM thread_lifecycle WHERE thread_id = ?`).get("current"),
      undefined,
    );
  });

  it("returns a legacy archived settle regardless of its age", async () => {
    const { db, handlers } = createHarness();
    const settledAt = Date.now() - 7 * 24 * 60 * 60 * 1000;
    db.prepare(
      `INSERT INTO thread_lifecycle
         (thread_id, settled_at, snoozed_until, snoozed_at, archived_thread_ids)
       VALUES (?, ?, NULL, NULL, ?)`,
    ).run("legacy", settledAt, JSON.stringify(["legacy"]));

    const result = await handlers.listSettledThreads();

    assert.deepEqual(
      result.threads.map((thread) => ({ id: thread.id, settledAt: thread.settledAt })),
      [{ id: "legacy", settledAt }],
    );
  });
});
