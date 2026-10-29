import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createStore, MIGRATIONS, repairIssueSchema, repairKeywordSchema } from "./db";
import type { Run } from "./types";

const databases: Database.Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function makeStore() {
  const database = new Database(":memory:");
  databases.push(database);
  for (const migration of MIGRATIONS) database.exec(migration);
  repairKeywordSchema(database);
  return { database, store: createStore(database) };
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "run_1",
    ruleId: "rule_1",
    ruleName: "triage",
    repo: "acme/widgets",
    targetKind: "issue",
    prNumber: 42,
    prTitle: "Widget fails",
    prAuthor: "dana",
    headSha: "",
    status: "reviewing",
    trigger: "manual",
    triggerEventId: null,
    mode: "shadow",
    detail: null,
    threadId: "thread_1",
    commentCount: 0,
    startedAt: 1,
    finishedAt: null,
    ...overrides,
  };
}

describe("issue persistence", () => {
  it("repairs issue tables after a migration index collision", () => {
    const database = new Database(":memory:");
    databases.push(database);
    for (const migration of MIGRATIONS.slice(0, 10)) database.exec(migration);
    database.exec(`ALTER TABLE runs ADD COLUMN trigger TEXT NOT NULL DEFAULT 'manual'`);

    repairIssueSchema(database);
    repairIssueSchema(database);
    repairKeywordSchema(database);
    repairKeywordSchema(database);

    const store = createStore(database);
    store.insertRun(makeRun());
    store.markIssueBootstrapped("acme/widgets", 100);
    store.markIssueSeen("acme/widgets", 42, 100);

    expect(store.getRun("run_1")?.targetKind).toBe("issue");
    expect(store.isIssueBootstrapped("acme/widgets")).toBe(true);
    expect(store.hasSeenIssue("acme/widgets", 42)).toBe(true);
  });

  it("round-trips the target kind and keeps PR dedupe separate", () => {
    const { store } = makeStore();
    store.insertRun(makeRun());

    expect(store.getRun("run_1")?.targetKind).toBe("issue");
    expect(store.hasRunFor("rule_1", "acme/widgets", "issue", 42, null)).toBe(true);
    expect(store.hasRunFor("rule_1", "acme/widgets", "pull_request", 42, null)).toBe(false);
  });

  it("tracks the issue backlog independently from pull requests", () => {
    const { store } = makeStore();
    expect(store.isIssueBootstrapped("acme/widgets")).toBe(false);
    expect(store.hasSeenIssue("acme/widgets", 42)).toBe(false);

    store.markIssueBootstrapped("acme/widgets", 100);
    store.markIssueSeen("acme/widgets", 42, 100);

    expect(store.isIssueBootstrapped("acme/widgets")).toBe(true);
    expect(store.hasSeenIssue("acme/widgets", 42)).toBe(true);
    expect(store.isBootstrapped("acme/widgets")).toBe(false);
  });
});

describe("run rows", () => {
  it("rejects a persisted status outside the enum instead of reading it as in progress", () => {
    const { database, store } = makeStore();
    store.insertRun(makeRun());
    database.prepare(`UPDATE runs SET status = 'bogus' WHERE id = ?`).run("run_1");

    expect(() => store.getRun("run_1")).toThrow();
  });

  it("lets the first finish claim a thread's run and stops counting it as reviewing", () => {
    const { store } = makeStore();
    store.insertRun(makeRun());
    store.insertRun(makeRun({ id: "run_2", threadId: "thread_2" }));
    expect(store.countReviewing()).toBe(2);

    expect(store.claimFinished("thread_1", 5)?.id).toBe("run_1");
    expect(store.claimFinished("thread_1", 6)).toBeNull();
    expect(store.claimFinished("thread_none", 6)).toBeNull();

    expect(store.countReviewing()).toBe(1);
    expect(store.getRun("run_1")?.finishedAt).toBe(5);
  });
});
