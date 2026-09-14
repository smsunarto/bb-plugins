// Behavior tests for the initiative store and service: real SQLite for the
// store (in-memory), and a fake threads seam that models core's real
// dispatch semantics — a spawn's first message is admitted by the
// message.dispatch gate inside the spawn call, queued on wait, and
// re-attempted by recheck drains. The harness records the membership answer
// the session would get at construction, which is what first-turn tools and
// instructions actually depend on.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Database } from "bun:sqlite";
import type { Database as BetterSqliteDatabase } from "better-sqlite3";
import {
  buildContextTree,
  createInitiativeStore,
  INITIATIVE_MIGRATIONS,
  INITIATIVE_SHARED_DIRECTORY_MIGRATIONS,
  normalizeContextPath,
} from "../lib/initiative-store.ts";
import {
  createInitiativeService,
  INITIATIVE_INIT_MARKER,
  type DispatchGateDecision,
} from "../lib/initiative-service.ts";
import { INITIATIVES_CHANNEL, SUBSCRIPTIONS_CHANNEL } from "../lib/initiative-types.ts";
import { SUBSCRIPTIONS_REALTIME_CHANNEL } from "../lib/initiative-subscriptions.ts";

// The store is typed against better-sqlite3, whose .get() returns undefined
// for a missing row; bun:sqlite returns null. This adapter normalizes so the
// tests exercise the production contract instead of bending it.
function makeDb(path = ":memory:", applyMigrations = true): BetterSqliteDatabase {
  const inner = new Database(path);
  const db = {
    exec: (sql: string) => inner.exec(sql),
    prepare: (sql: string) => {
      const statement = inner.prepare(sql);
      return {
        run: (...args: unknown[]) => statement.run(...(args as never[])),
        get: (...args: unknown[]) => statement.get(...(args as never[])) ?? undefined,
        all: (...args: unknown[]) => statement.all(...(args as never[])),
      };
    },
    transaction: (fn: (...args: never[]) => unknown) => inner.transaction(fn),
    close: () => inner.close(),
  };
  if (applyMigrations) {
    for (const statement of INITIATIVE_MIGRATIONS) db.exec(statement);
    for (const statement of INITIATIVE_SHARED_DIRECTORY_MIGRATIONS) db.exec(statement);
  }
  return db as unknown as BetterSqliteDatabase;
}

function makeInput(overrides: Record<string, unknown> = {}) {
  const projectIds = (overrides.workspaceProjectIds as string[] | undefined) ?? [
    "proj_a",
    "proj_b",
  ];
  return {
    id: "init_1",
    name: "Alpha",
    icon: "A",
    description: "first",
    coordinatorThreadId: "thr_coord1",
    workspace: { mode: "legacy" as const },
    workspaceBindings: projectIds.map((projectId) => ({ projectId, hostId: null, path: null })),
    primaryEnvironmentId: null,
    providerId: null,
    model: null,
    reasoningLevel: null,
    ...overrides,
  };
}

describe("initiative store", () => {
  it("upgrades existing rows to legacy mode without changing their bindings", () => {
    const db = makeDb(":memory:", false);
    for (const statement of INITIATIVE_MIGRATIONS) db.exec(statement);
    db.prepare(
      `INSERT INTO initiative
         (id, name, icon, description, coordinator_thread_id, primary_environment_id,
          provider_id, model, reasoning_level, created_at, updated_at, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run("init_old", "Old", "", "", "thr_old", null, null, null, null, 1, 1);
    db.prepare(
      `INSERT INTO initiative_workspace (initiative_id, project_id, position) VALUES (?, ?, ?)`,
    ).run("init_old", "proj_old", 0);
    for (const statement of INITIATIVE_SHARED_DIRECTORY_MIGRATIONS) db.exec(statement);

    const initiative = createInitiativeStore(db).get("init_old");
    assert.deepEqual(initiative?.workspace, { mode: "legacy" });
    assert.deepEqual(initiative?.workspaceProjectIds, ["proj_old"]);
  });

  it("enforces shared-directory bindings and resolves its pending environment once", () => {
    const store = createInitiativeStore(makeDb());
    assert.throws(
      () =>
        store.create({
          ...makeInput(),
          workspace: { mode: "shared-directory", hostId: "host_a", rootPath: "/repos" },
          workspaceBindings: [
            { projectId: "proj_a", hostId: "host_a", path: "/repos/a" },
            { projectId: "proj_b", hostId: "host_a", path: null },
          ],
          primaryEnvironmentId: "env_a",
        }),
      /incomplete/,
    );
    const created = store.create({
      ...makeInput(),
      workspace: { mode: "shared-directory", hostId: "host_a", rootPath: "/repos" },
      workspaceBindings: [
        { projectId: "proj_a", hostId: "host_a", path: "/repos/a" },
        { projectId: "proj_b", hostId: "host_a", path: "/repos/b" },
      ],
      primaryEnvironmentId: null,
    });
    assert.equal(created.workspace.mode, "shared-directory");
    assert.equal(created.primaryEnvironmentId, null);
    assert.equal(store.setPrimaryEnvironmentId(created.id, "env_a").primaryEnvironmentId, "env_a");
    assert.equal(store.setPrimaryEnvironmentId(created.id, "env_a").primaryEnvironmentId, "env_a");
    assert.throws(
      () => store.setPrimaryEnvironmentId(created.id, "env_other"),
      /already bound to environment env_a/,
    );
    assert.throws(() => store.update(created.id, { workspaceProjectIds: ["proj_a"] }), /immutable/);
  });

  it("creates, reads, lists, updates, archives and removes", () => {
    const store = createInitiativeStore(makeDb());
    const created = store.create(makeInput());
    assert.equal(created.id, "init_1");
    assert.deepEqual(created.workspaceProjectIds, ["proj_a", "proj_b"]);
    assert.equal(created.archivedAt, null);

    assert.equal(store.get("init_1")?.name, "Alpha");
    assert.equal(store.getByCoordinator("thr_coord1")?.id, "init_1");
    assert.deepEqual(store.coordinatorThreadIds(), ["thr_coord1"]);

    store.create(
      makeInput({
        id: "init_2",
        name: "Beta",
        coordinatorThreadId: "thr_coord2",
        workspaceProjectIds: ["proj_b"],
      }),
    );
    assert.deepEqual(
      store.list().map((i) => i.id),
      ["init_1", "init_2"],
    );
    assert.deepEqual(
      store.list({ workspaceProjectId: "proj_b" }).map((i) => i.id),
      ["init_1", "init_2"],
    );
    assert.deepEqual(
      store.list({ workspaceProjectId: "proj_a" }).map((i) => i.id),
      ["init_1"],
    );

    const updated = store.update("init_1", { name: "Alpha 2", workspaceProjectIds: ["proj_c"] });
    assert.equal(updated.name, "Alpha 2");
    assert.deepEqual(updated.workspaceProjectIds, ["proj_c"]);
    assert.deepEqual(store.list({ workspaceProjectId: "proj_a" }), []);

    assert.notEqual(store.setArchived("init_1", true).archivedAt, null);
    assert.equal(store.setArchived("init_1", false).archivedAt, null);

    store.writeDoc({ initiativeId: "init_1", path: "a.md", content: "x" });
    store.remove("init_1");
    assert.equal(store.get("init_1"), null);
    assert.deepEqual(store.listDocs("init_1"), []);
  });

  it("rejects a second initiative claiming the same coordinator thread", () => {
    const store = createInitiativeStore(makeDb());
    store.create(makeInput());
    assert.throws(() => store.create(makeInput({ id: "init_2" })), /UNIQUE|unique/i);
  });

  it("enforces numeric revision CAS on context docs", () => {
    const store = createInitiativeStore(makeDb());
    store.create(makeInput());

    // create-only
    assert.deepEqual(
      store.writeDoc({
        initiativeId: "init_1",
        path: "plan.md",
        content: "v1",
        expectedRevision: 0,
      }),
      { outcome: "written", revision: 1 },
    );
    // guarded overwrite
    assert.deepEqual(
      store.writeDoc({
        initiativeId: "init_1",
        path: "plan.md",
        content: "v2",
        expectedRevision: 1,
      }),
      { outcome: "written", revision: 2 },
    );
    // stale revision conflicts and reports the live revision
    assert.deepEqual(
      store.writeDoc({
        initiativeId: "init_1",
        path: "plan.md",
        content: "v3",
        expectedRevision: 1,
      }),
      { outcome: "conflict", revision: 2 },
    );
    // create-only on an existing doc conflicts
    assert.deepEqual(
      store.writeDoc({
        initiativeId: "init_1",
        path: "plan.md",
        content: "v4",
        expectedRevision: 0,
      }),
      { outcome: "conflict", revision: 2 },
    );
    // missing revision guard on a nonexistent path conflicts at 0
    assert.deepEqual(
      store.writeDoc({ initiativeId: "init_1", path: "new.md", content: "x", expectedRevision: 3 }),
      { outcome: "conflict", revision: 0 },
    );
    // omitted revision is an unconditional upsert and stays monotonic
    assert.deepEqual(store.writeDoc({ initiativeId: "init_1", path: "plan.md", content: "v5" }), {
      outcome: "written",
      revision: 3,
    });
    assert.equal(store.getDoc("init_1", "plan.md")?.content, "v5");
  });

  it("rejects writes and deletes for unknown initiatives", () => {
    const store = createInitiativeStore(makeDb());
    assert.throws(
      () => store.writeDoc({ initiativeId: "init_nope", path: "a.md", content: "x" }),
      /not found/,
    );
    assert.throws(() => store.deleteDoc("init_nope", "a.md"), /not found/);
  });

  it("enforces the logical path policy", () => {
    for (const bad of [
      "",
      "/abs.md",
      "a\\b.md",
      "a//b.md",
      "./a.md",
      "a/./b.md",
      "a/../b.md",
      "a.md/",
      "a\tb.md",
    ]) {
      assert.throws(() => normalizeContextPath(bad), /context doc path/, bad);
    }
    assert.equal(normalizeContextPath("notes/plan.md"), "notes/plan.md");
    assert.equal(normalizeContextPath("deep/a/b/c.md"), "deep/a/b/c.md");
  });

  it("rejects file/directory collisions at the write boundary", () => {
    const store = createInitiativeStore(makeDb());
    store.create(makeInput());
    store.writeDoc({ initiativeId: "init_1", path: "notes", content: "file" });
    // a file cannot gain children
    assert.throws(
      () => store.writeDoc({ initiativeId: "init_1", path: "notes/x.md", content: "y" }),
      /inside the file/,
    );
    // and a directory cannot be overwritten by a file
    store.writeDoc({ initiativeId: "init_1", path: "docs/guide.md", content: "g" });
    assert.throws(
      () => store.writeDoc({ initiativeId: "init_1", path: "docs", content: "d" }),
      /is a directory/,
    );
    // existing docs remain visible and writable
    assert.equal(store.getDoc("init_1", "notes")?.content, "file");
    assert.equal(store.getDoc("init_1", "docs/guide.md")?.content, "g");
    assert.deepEqual(
      store.listDocs("init_1").map((d) => d.path),
      ["docs/guide.md", "notes"],
    );
  });

  it("prefix-deletes directory subtrees", () => {
    const store = createInitiativeStore(makeDb());
    store.create(makeInput());
    store.writeDoc({ initiativeId: "init_1", path: "a/b/c.md", content: "1" });
    store.writeDoc({ initiativeId: "init_1", path: "a/d.md", content: "2" });
    store.writeDoc({ initiativeId: "init_1", path: "keep.md", content: "3" });
    assert.equal(store.deleteDoc("init_1", "a"), 2);
    assert.deepEqual(
      store.listDocs("init_1").map((d) => d.path),
      ["keep.md"],
    );
  });

  it("prefix deletes are case-sensitive, unlike SQL LIKE", () => {
    const store = createInitiativeStore(makeDb());
    store.create(makeInput());
    store.writeDoc({ initiativeId: "init_1", path: "A/keep.md", content: "stay" });
    store.writeDoc({ initiativeId: "init_1", path: "a/remove.md", content: "go" });
    // LIKE 'a/%' would swallow A/keep.md (ASCII case-insensitive); the
    // byte-exact prefix match must not.
    assert.equal(store.deleteDoc("init_1", "a"), 1);
    assert.equal(store.getDoc("init_1", "A/keep.md")?.content, "stay");
    assert.equal(store.getDoc("init_1", "a/remove.md"), null);
    // Collision checks are case-sensitive the same way: b is NOT inside the
    // unrelated B directory, so the write stands.
    store.writeDoc({ initiativeId: "init_1", path: "B/file.md", content: "x" });
    store.writeDoc({ initiativeId: "init_1", path: "b", content: "own file" });
    assert.equal(store.getDoc("init_1", "b")?.content, "own file");
    assert.equal(store.getDoc("init_1", "B/file.md")?.content, "x");
  });

  it("treats % and _ as literal characters in paths", () => {
    const store = createInitiativeStore(makeDb());
    store.create(makeInput());
    store.writeDoc({ initiativeId: "init_1", path: "100%.md", content: "pct" });
    store.writeDoc({ initiativeId: "init_1", path: "a_b/x.md", content: "under" });
    store.writeDoc({ initiativeId: "init_1", path: "acb/y.md", content: "decoy" });
    // Deleting a_b must not reach acb (the _ wildcard would match 'c').
    assert.equal(store.deleteDoc("init_1", "a_b"), 1);
    assert.equal(store.getDoc("init_1", "acb/y.md")?.content, "decoy");
    assert.equal(store.getDoc("init_1", "100%.md")?.content, "pct");
    // And a literal % path writes and deletes like any other.
    assert.equal(store.deleteDoc("init_1", "100%.md"), 1);
    assert.equal(store.getDoc("init_1", "100%.md"), null);
  });

  it("rolls back the whole write when a tree check fails mid-transaction", () => {
    const store = createInitiativeStore(makeDb());
    store.create(makeInput());
    store.writeDoc({ initiativeId: "init_1", path: "dir/f.md", content: "kept" });
    // The collision throws inside the transaction — the earlier insert of
    // this write must not survive it.
    assert.throws(() => store.writeDoc({ initiativeId: "init_1", path: "dir", content: "boom" }));
    assert.equal(store.getDoc("init_1", "dir"), null);
    assert.equal(store.getDoc("init_1", "dir/f.md")?.content, "kept");
    assert.deepEqual(
      store.listDocs("init_1").map((d) => d.path),
      ["dir/f.md"],
    );
  });

  it("persists across a close and reopen", () => {
    const file = join(tmpdir(), `bb-init-reopen-${process.pid}-${Date.now()}.sqlite`);
    try {
      const first = createInitiativeStore(makeDb(file));
      first.create(makeInput());
      first.writeDoc({ initiativeId: "init_1", path: "note.md", content: "durable" });
      const second = createInitiativeStore(makeDb(file, false));
      assert.equal(second.get("init_1")?.name, "Alpha");
      assert.equal(second.getDoc("init_1", "note.md")?.content, "durable");
      assert.deepEqual(second.coordinatorThreadIds(), ["thr_coord1"]);
    } finally {
      rmSync(file, { force: true });
    }
  });

  it("builds a sorted directory tree with derived directories", () => {
    const tree = buildContextTree([
      { path: "z-last.md", revision: 1, sizeBytes: 1, updatedAt: 1 },
      { path: "notes/b.md", revision: 1, sizeBytes: 1, updatedAt: 1 },
      { path: "notes/deep/c.md", revision: 1, sizeBytes: 1, updatedAt: 1 },
      { path: "a-first.md", revision: 1, sizeBytes: 1, updatedAt: 1 },
    ]);
    assert.deepEqual(
      tree.map((n) => n.path),
      ["notes", "a-first.md", "z-last.md"],
    );
    const notes = tree[0];
    assert.equal(notes?.kind, "directory");
    assert.deepEqual(
      notes?.children?.map((n) => n.path),
      ["notes/deep", "notes/b.md"],
    );
  });
});

// ---------------------------------------------------------------------------
// Service harness: a fake threads seam modeling core's dispatch semantics.
// ---------------------------------------------------------------------------

interface FakeThread {
  id: string;
  parentThreadId: string | null;
  projectId: string;
  title: string | null;
  archivedAt: number | null;
  deletedAt: number | null;
  status: string;
  createdAt: number;
  environmentId: string | null;
}

interface SpawnArgs {
  projectId?: string;
  parentThreadId?: string;
  title?: string;
  visibility?: string;
  input?: { type: string; text?: string; visibility?: string }[];
  [key: string]: unknown;
}

function makeHarness() {
  const rows = new Map<string, FakeThread>();
  const spawnCalls: SpawnArgs[] = [];
  const spawnByThread = new Map<string, SpawnArgs>();
  const archiveCalls: string[] = [];
  const unarchiveCalls: string[] = [];
  const deleteCalls: string[] = [];
  const getCalls: string[] = [];
  const failArchives = new Set<string>();
  const failUnarchives = new Set<string>();
  const harness = {
    failNextSpawn: false,
    failNextStoreCreate: false,
    omitNextEnvironmentId: false,
    failEnvironmentProvisioning: false,
    environmentResolutionDelayReads: 1,
    environmentStatusOnAttach: "starting" as FakeThread["status"],
    rewriteValidatedPathsTo: null as string | null,
    rewriteValidatedRootTo: null as string | null,
  };
  const pendingHostEnvironments = new Map<string, string>();
  const environmentResolutionReads = new Map<string, number>();
  let environmentClock = 0;
  let seq = 0;

  const api = {
    async spawn(args: SpawnArgs) {
      spawnCalls.push(args);
      if (harness.failNextSpawn) {
        harness.failNextSpawn = false;
        throw new Error("spawn blew up");
      }
      const id = `thr_${++seq}`;
      const environment = args.environment as { type?: string; environmentId?: string } | undefined;
      const environmentId =
        environment?.type === "reuse" ? (environment.environmentId ?? null) : null;
      if (environment?.type === "host" && !harness.omitNextEnvironmentId) {
        // Core cannot create/attach this environment until the dispatch gate
        // admits the thread and provisioning begins.
        pendingHostEnvironments.set(id, `env_${seq}`);
      }
      harness.omitNextEnvironmentId = false;
      rows.set(id, {
        id,
        parentThreadId: args.parentThreadId ?? null,
        projectId: args.projectId ?? "proj_personal",
        title: args.title ?? null,
        archivedAt: null,
        deletedAt: null,
        status: "pending",
        createdAt: seq,
        environmentId,
      });
      // The dispatch admission runs INSIDE spawn: a held message queues and
      // spawn returns the pending thread.
      spawnByThread.set(id, args);
      const decision = await service.dispatchGate({
        threadId: id,
        parentThreadId: args.parentThreadId ?? null,
        originPluginId: "gtd-sidebar",
        inputBlocks: args.input ?? [],
      });
      if (decision.action === "wait") pendingDispatch.add(id);
      else if (decision.action === "reject") rejectedDispatch.add(id);
      else {
        dispatched.add(id);
        admissionAnswers.set(id, service.membership.roleHint(id, args.parentThreadId ?? null));
      }
      return rows.get(id)!;
    },
    async send() {
      return { ok: true };
    },
    async get({ threadId }: { threadId: string }) {
      getCalls.push(threadId);
      const row = rows.get(threadId);
      if (row === undefined) throw new Error(`thread ${threadId} not found`);
      const pendingEnvironment = pendingHostEnvironments.get(threadId);
      if (pendingEnvironment !== undefined && dispatched.has(threadId)) {
        const reads = (environmentResolutionReads.get(threadId) ?? 0) + 1;
        environmentResolutionReads.set(threadId, reads);
        if (reads > harness.environmentResolutionDelayReads) {
          row.environmentId = pendingEnvironment;
          row.status = harness.environmentStatusOnAttach;
          pendingHostEnvironments.delete(threadId);
        }
      }
      return row;
    },
    async list({
      parentThreadId,
      archived,
      limit,
      offset,
    }: {
      parentThreadId: string;
      archived?: boolean;
      limit?: number;
      offset?: number;
    }) {
      const all = [...rows.values()].filter(
        (t) =>
          t.parentThreadId === parentThreadId &&
          t.deletedAt === null &&
          // Core's semantics: archived omitted lists both states.
          (archived === undefined || (t.archivedAt !== null) === archived),
      );
      const start = offset ?? 0;
      return all.slice(start, limit === undefined ? undefined : start + limit);
    },
    async update({
      threadId,
      parentThreadId,
    }: {
      threadId: string;
      parentThreadId?: string | null;
    }) {
      const row = rows.get(threadId);
      if (row === undefined) throw new Error(`thread ${threadId} not found`);
      if (parentThreadId !== undefined) row.parentThreadId = parentThreadId;
      return row;
    },
    async delete({ threadId }: { threadId: string }) {
      deleteCalls.push(threadId);
      const row = rows.get(threadId);
      if (row !== undefined) row.deletedAt = Date.now();
      // Core cancels a queued first message when its pending thread is
      // deleted. Do not erase admitted dispatches here: that distinction
      // keeps the initialization test able to catch an envelope parse miss.
      pendingDispatch.delete(threadId);
    },
    async archive({ threadId }: { threadId: string }) {
      archiveCalls.push(threadId);
      if (failArchives.has(threadId)) throw new Error(`archive ${threadId} failed`);
      const row = rows.get(threadId);
      if (row !== undefined) row.archivedAt = Date.now();
    },
    async unarchive({ threadId }: { threadId: string }) {
      unarchiveCalls.push(threadId);
      if (failUnarchives.has(threadId)) throw new Error(`unarchive ${threadId} failed`);
      const row = rows.get(threadId);
      if (row !== undefined) row.archivedAt = null;
    },
  };

  /** Dispatches still held behind the gate. */
  const pendingDispatch = new Set<string>();
  /** Dispatches admitted — the session this message starts is constructed now. */
  const dispatched = new Set<string>();
  const rejectedDispatch = new Set<string>();
  /** What membership would resolve to at session construction, recorded at admission. */
  const admissionAnswers = new Map<string, string | null>();

  const projects = {
    async list() {
      return [{ id: "proj_personal", kind: "personal" }];
    },
    async get({ projectId }: { projectId: string }) {
      return {
        id: projectId,
        name: projectId,
        sources: [{ hostId: "host_a", path: `/repos/${projectId}`, isDefault: true }],
      };
    },
  };
  const published: { channel: string; payload: unknown }[] = [];
  let service: ReturnType<typeof createInitiativeService>;
  const drain = async (): Promise<void> => {
    // Set iteration tolerates deletion: a drained entry won't be revisited.
    for (const threadId of pendingDispatch) {
      const row = rows.get(threadId);
      const spawn = spawnByThread.get(threadId);
      const decision = await service.dispatchGate({
        threadId,
        parentThreadId: row?.parentThreadId ?? null,
        originPluginId: "gtd-sidebar",
        inputBlocks: spawn?.input ?? [],
      });
      if (decision.action === "proceed") {
        pendingDispatch.delete(threadId);
        dispatched.add(threadId);
        if (row !== undefined) {
          row.status = harness.failEnvironmentProvisioning ? "error" : "starting";
          if (harness.failEnvironmentProvisioning) {
            pendingHostEnvironments.delete(threadId);
            harness.failEnvironmentProvisioning = false;
          }
        }
        admissionAnswers.set(
          threadId,
          service.membership.roleHint(threadId, row?.parentThreadId ?? null),
        );
      }
    }
  };
  const store = createInitiativeStore(makeDb());
  const persistInitiative = store.create.bind(store);
  store.create = (input) => {
    if (harness.failNextStoreCreate) {
      harness.failNextStoreCreate = false;
      throw new Error("store create blew up");
    }
    return persistInitiative(input);
  };
  const makeService = () =>
    createInitiativeService({
      store,
      threads: api as never,
      projects: projects as never,
      hosts: {
        async get() {
          return { id: "host_a", name: "Machine A", status: "connected" };
        },
      } as never,
      inspectSharedDirectory: async (_hostId, input) => ({
        homePath: "/home/test",
        filesystemRootPath: "/",
        suggestedRootPath: "/repos",
        repositories: input.repositoryPaths.map((path) => ({
          requestedPath: path,
          canonicalPath: harness.rewriteValidatedPathsTo ?? path,
          kind: "directory" as const,
          message: null,
        })),
        root:
          input.rootPath === undefined
            ? null
            : {
                requestedPath: input.rootPath,
                canonicalPath: harness.rewriteValidatedRootTo ?? input.rootPath,
                kind: "directory" as const,
                message: null,
              },
        rootContainsRepositories: input.repositoryPaths.map(() => true),
      }),
      pluginId: "gtd-sidebar",
      publish: (channel, payload) => published.push({ channel, payload }),
      log: { info() {}, warn() {}, error() {} },
      recheckDispatch: drain,
      environmentResolution: {
        timeoutMs: 5,
        pollIntervalMs: 1,
        now: () => environmentClock,
        wait: async (milliseconds) => {
          environmentClock += milliseconds;
        },
      },
    });
  service = makeService();
  return {
    api,
    rows,
    spawnCalls,
    archiveCalls,
    unarchiveCalls,
    deleteCalls,
    getCalls,
    failArchives,
    failUnarchives,
    get failNextSpawn() {
      return harness.failNextSpawn;
    },
    set failNextSpawn(value: boolean) {
      harness.failNextSpawn = value;
    },
    get failNextStoreCreate() {
      return harness.failNextStoreCreate;
    },
    set failNextStoreCreate(value: boolean) {
      harness.failNextStoreCreate = value;
    },
    set omitNextEnvironmentId(value: boolean) {
      harness.omitNextEnvironmentId = value;
    },
    set failEnvironmentProvisioning(value: boolean) {
      harness.failEnvironmentProvisioning = value;
    },
    set environmentResolutionDelayReads(value: number) {
      harness.environmentResolutionDelayReads = value;
    },
    set environmentStatusOnAttach(value: FakeThread["status"]) {
      harness.environmentStatusOnAttach = value;
    },
    set rewriteValidatedPathsTo(value: string | null) {
      harness.rewriteValidatedPathsTo = value;
    },
    set rewriteValidatedRootTo(value: string | null) {
      harness.rewriteValidatedRootTo = value;
    },
    pendingDispatch,
    dispatched,
    rejectedDispatch,
    admissionAnswers,
    environmentResolutionReads,
    published,
    store,
    service,
    drain,
    reloadService() {
      service = makeService();
      return service;
    },
    addThread(partial: Partial<FakeThread> & { id: string }) {
      rows.set(partial.id, {
        parentThreadId: null,
        projectId: "proj_personal",
        title: partial.id,
        archivedAt: null,
        deletedAt: null,
        status: "idle",
        createdAt: ++seq,
        environmentId: null,
        ...partial,
      });
    },
  };
}

const hasMarker = (args: SpawnArgs | undefined): boolean =>
  (args?.input ?? []).some(
    (b) =>
      b.type === "text" &&
      b.visibility === "agent-only" &&
      typeof b.text === "string" &&
      b.text.includes(INITIATIVE_INIT_MARKER),
  );

const initEnvelope = (nonce: string): string =>
  `\n\n<!-- ${INITIATIVE_INIT_MARKER}${nonce}; plugin-internal initialization metadata; not part of the task; do not reproduce -->\n\n`;

describe("initiative service — first-turn initialization", () => {
  it("holds the marked coordinator dispatch until the registry commits", async () => {
    const h = makeHarness();
    const { initiative, threadId } = await h.service.createInitiative({
      name: "Gate",
      workspaceProjectIds: [],
      initialPrompt: "start",
    });
    // spawn's first message was held inside the spawn call, then released by
    // the recheck drain after the registry row + coordinator set landed.
    const spawn = h.spawnCalls[0];
    assert.equal(hasMarker(spawn), true);
    assert.equal(h.dispatched.has(threadId), true);
    assert.equal(h.pendingDispatch.size, 0);
    // At admission the session resolves the coordinator role — tools and
    // instructions are available from the first turn.
    assert.equal(h.admissionAnswers.get(threadId), "coordinator");
    assert.equal(initiative.coordinatorThreadId, threadId);
    assert.equal(h.store.getByCoordinator(threadId)?.id, initiative.id);
  });

  it("deletes the pending thread when the registry commit fails", async () => {
    const h = makeHarness();
    h.failNextStoreCreate = true;
    await assert.rejects(
      h.service.createInitiative({ name: "Clash", workspaceProjectIds: [] }),
      /store create blew up/,
    );
    // The spawned pending thread (thr_1) must be deleted, not left as a ghost.
    assert.equal(h.deleteCalls.length, 1);
    assert.notEqual(h.rows.get("thr_1")?.deletedAt, null);
  });

  it("admits the marked child with membership indexed before its session", async () => {
    const h = makeHarness();
    const { initiative, threadId } = await h.service.createInitiative({
      name: "Parent",
      workspaceProjectIds: [],
    });
    const { threadId: childId } = await h.service.spawnAgent({
      initiativeId: initiative.id,
      prompt: "do work",
    });
    const childSpawn = h.spawnCalls[1];
    assert.equal(hasMarker(childSpawn), true);
    assert.equal(childSpawn?.parentThreadId, threadId);
    // The child's ancestry is durable at create time, so the gate resolves it
    // immediately — and indexes it before answering proceed, which is what the
    // synchronous instructions hook needs at session construction.
    assert.equal(h.dispatched.has(childId), true);
    assert.equal(h.admissionAnswers.get(childId), "agent");
    assert.equal(h.service.membership.descendantInitiative(childId), initiative.id);
    assert.equal(h.rejectedDispatch.size, 0);
  });

  it("rejects marked dispatches whose initialization never committed", async () => {
    const h = makeHarness();
    // An orphan: marker present, no pending init, no membership — a reload
    // leftover or a failed create. Fail closed.
    const decision: DispatchGateDecision = await h.service.dispatchGate({
      threadId: "thr_orphan",
      parentThreadId: null,
      originPluginId: "gtd-sidebar",
      inputBlocks: [
        {
          type: "text",
          text: initEnvelope("00000000-0000-4000-8000-000000000000"),
          visibility: "agent-only",
        },
      ],
    });
    assert.equal(decision.action, "reject");
  });

  it("indexes an unmarked child of a member before its first session", async () => {
    const h = makeHarness();
    const { initiative, threadId } = await h.service.createInitiative({
      name: "Raw",
      workspaceProjectIds: [],
    });
    // Simulate a raw `bb thread spawn --parent-self` under the coordinator:
    // created by core without our marker.
    h.addThread({ id: "thr_raw", parentThreadId: threadId });
    const decision = await h.service.dispatchGate({
      threadId: "thr_raw",
      parentThreadId: threadId,
      originPluginId: "cli",
      inputBlocks: [{ type: "text", text: "hi" }],
    });
    assert.equal(decision.action, "proceed");
    assert.equal(h.service.membership.descendantInitiative("thr_raw"), initiative.id);
    assert.equal(h.service.membership.roleHint("thr_raw", threadId), "agent");
  });

  it("proceeds for threads unrelated to any initiative", async () => {
    const h = makeHarness();
    const decision = await h.service.dispatchGate({
      threadId: "thr_other",
      parentThreadId: null,
      originPluginId: null,
      inputBlocks: [{ type: "text", text: "ordinary message" }],
    });
    assert.equal(decision.action, "proceed");
  });

  it("skips ancestry reads for child dispatches when no initiatives exist", async () => {
    const h = makeHarness();
    h.addThread({ id: "thr_parent" });
    h.addThread({ id: "thr_child", parentThreadId: "thr_parent" });
    const readsBefore = h.getCalls.length;
    const decision = await h.service.dispatchGate({
      threadId: "thr_child",
      parentThreadId: "thr_parent",
      originPluginId: null,
      inputBlocks: [{ type: "text", text: "ordinary child message" }],
    });
    assert.equal(decision.action, "proceed");
    assert.equal(h.getCalls.length, readsBefore);
  });

  it("assembles an exact separated marker envelope and parses its nonce back", async () => {
    const h = makeHarness();
    h.failNextStoreCreate = true;
    await assert.rejects(
      h.service.createInitiative({ name: "Clash", workspaceProjectIds: [] }),
      /store create blew up/,
    );
    const markerBlock = (h.spawnCalls[0]?.input ?? [])[1];
    // Blank lines are part of the block because providers concatenate block
    // text directly. The metadata therefore cannot extend a literal reply.
    assert.match(
      markerBlock?.text ?? "",
      /^\n\n<!-- initiative-init:v1:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}; plugin-internal initialization metadata; not part of the task; do not reproduce -->\n\n$/,
    );
    // And the nonce inside still round-trips through the gate's parser: the
    // held dispatch belonged to the in-flight init, so it was queued (not
    // rejected as an orphan) before the registry commit failed.
    assert.equal(h.pendingDispatch.size + h.dispatched.size, 0);
    assert.equal(h.rejectedDispatch.size, 0);
    // The same nonce, replayed now that init is gone, parses and fails closed.
    const nonce = /^\n\n<!-- initiative-init:v1:([0-9a-f-]{36});/.exec(
      markerBlock?.text ?? "",
    )?.[1];
    assert.ok(nonce !== undefined);
    const orphan = await h.service.dispatchGate({
      threadId: "thr_replayed",
      parentThreadId: null,
      originPluginId: "gtd-sidebar",
      inputBlocks: [{ type: "text", text: markerBlock!.text, visibility: "agent-only" }],
    });
    assert.equal(orphan.action, "reject");
  });

  it("does not parse an envelope embedded in arbitrary agent-only prompt text", async () => {
    const h = makeHarness();
    const envelope = initEnvelope("00000000-0000-4000-8000-000000000000");
    const decision = await h.service.dispatchGate({
      threadId: "thr_prompt",
      parentThreadId: null,
      originPluginId: "gtd-sidebar",
      inputBlocks: [
        {
          type: "text",
          text: `Before metadata${envelope}after metadata`,
          visibility: "agent-only",
        },
      ],
    });
    assert.equal(decision.action, "proceed");
    assert.equal(h.rejectedDispatch.size, 0);
  });

  it("treats marker-shaped text from another origin as an ordinary message", async () => {
    const h = makeHarness();
    // A user or another plugin pasting the exact envelope is NOT gated — the
    // marker protocol only applies to this plugin's own dispatches.
    const decision = await h.service.dispatchGate({
      threadId: "thr_user",
      parentThreadId: null,
      originPluginId: null,
      inputBlocks: [
        {
          type: "text",
          text: initEnvelope("00000000-0000-4000-8000-000000000000"),
          visibility: "agent-only",
        },
      ],
    });
    assert.equal(decision.action, "proceed");
    assert.equal(h.rejectedDispatch.size, 0);
  });

  it("sends a visible initialPrompt but keeps the default bootstrap agent-only", async () => {
    const h = makeHarness();
    const replyOnlyPrompt = "Reply with exactly DONE and nothing else.";
    await h.service.createInitiative({
      name: "Visible",
      workspaceProjectIds: [],
      initialPrompt: replyOnlyPrompt,
    });
    const explicitBlocks = h.spawnCalls[0]?.input ?? [];
    const explicitPrompt = explicitBlocks[0];
    assert.equal(explicitPrompt?.type, "text");
    assert.equal(explicitPrompt?.text, replyOnlyPrompt);
    // Explicit prompt stays a normal visible block.
    assert.equal(explicitPrompt?.visibility, undefined);
    assert.equal(explicitBlocks[1]?.visibility, "agent-only");
    assert.match(
      explicitBlocks.map((block) => block.text ?? "").join(""),
      /^Reply with exactly DONE and nothing else\.\n\n<!-- initiative-init:v1:[0-9a-f-]{36}; .* -->\n\n$/,
    );

    await h.service.createInitiative({ name: "Default", workspaceProjectIds: [] });
    const defaultBlocks = h.spawnCalls[1]?.input ?? [];
    assert.equal(defaultBlocks[0]?.visibility, "agent-only");
    assert.match(defaultBlocks[0]?.text ?? "", /coordinator of the project/);
    assert.equal(defaultBlocks[1]?.visibility, "agent-only");
  });

  it("rolls back cleanly when the spawn itself fails", async () => {
    const h = makeHarness();
    h.failNextSpawn = true;
    await assert.rejects(
      h.service.createInitiative({ name: "Boom", workspaceProjectIds: [] }),
      /spawn blew up/,
    );
    assert.equal(h.store.list().length, 0);
    assert.equal(h.deleteCalls.length, 0); // nothing persisted to delete
  });

  it("indexes cold-reload descendants through ancestry at the gate", async () => {
    const h = makeHarness();
    const { initiative, threadId } = await h.service.createInitiative({
      name: "Reload",
      workspaceProjectIds: [],
    });
    h.addThread({ id: "thr_kid", parentThreadId: threadId });
    h.addThread({ id: "thr_grandkid", parentThreadId: "thr_kid" });

    // A second service over the same store = a reload: coordinator ids are
    // reseeded from the registry, but the descendant index starts empty.
    const reloaded = createInitiativeService({
      store: h.store,
      threads: h.api as never,
      projects: {
        async list() {
          return [];
        },
        async get() {
          throw new Error("not used");
        },
      } as never,
      hosts: {
        async get() {
          throw new Error("not used");
        },
      } as never,
      inspectSharedDirectory: async () => {
        throw new Error("not used");
      },
      pluginId: "gtd-sidebar",
      publish: () => {},
      log: { info() {}, warn() {}, error() {} },
      recheckDispatch: async () => {},
    });
    assert.equal(reloaded.membership.descendantInitiative("thr_kid"), null);

    // Its next dispatch walks durable ancestry and re-indexes before proceed.
    const kid = await reloaded.dispatchGate({
      threadId: "thr_kid",
      parentThreadId: threadId,
      originPluginId: "gtd-sidebar",
      inputBlocks: [{ type: "text", text: "next step" }],
    });
    assert.equal(kid.action, "proceed");
    assert.equal(reloaded.membership.descendantInitiative("thr_kid"), initiative.id);
    assert.equal(reloaded.membership.roleHint("thr_kid", threadId), "agent");

    // A deeper descendant whose parent is not yet indexed resolves through
    // the same ancestry walk.
    const grand = await reloaded.dispatchGate({
      threadId: "thr_grandkid",
      parentThreadId: "thr_kid",
      originPluginId: "gtd-sidebar",
      inputBlocks: [{ type: "text", text: "deeper" }],
    });
    assert.equal(grand.action, "proceed");
    assert.equal(reloaded.membership.descendantInitiative("thr_grandkid"), initiative.id);
    // The grandchild's own index entry resolves its role even while its
    // parent is still uncached — this is what its first session's tools and
    // instructions read.
    assert.equal(reloaded.membership.roleHint("thr_grandkid", "thr_kid"), "agent");
  });

  it("re-derives membership from ancestry when a thread is natively reparented", async () => {
    const h = makeHarness();
    const a = await h.service.createInitiative({ name: "A", workspaceProjectIds: [] });
    const b = await h.service.createInitiative({ name: "B", workspaceProjectIds: [] });
    const { threadId: childId } = await h.service.spawnAgent({
      initiativeId: a.initiative.id,
      prompt: "work",
    });
    assert.equal(h.service.membership.descendantInitiative(childId), a.initiative.id);

    // Native detach to root between turns: the next dispatch must clear the
    // stale claim, not keep serving project tools.
    h.rows.get(childId)!.parentThreadId = null;
    const detached = await h.service.dispatchGate({
      threadId: childId,
      parentThreadId: null,
      originPluginId: "gtd-sidebar",
      inputBlocks: [{ type: "text", text: "still here" }],
    });
    assert.equal(detached.action, "proceed");
    assert.equal(h.service.membership.descendantInitiative(childId), null);
    assert.equal(h.service.membership.roleHint(childId, null), null);

    // Native reparent under a different initiative's coordinator: the entry
    // moves to the authoritative ancestry, not the cached one.
    h.rows.get(childId)!.parentThreadId = b.threadId;
    const moved = await h.service.dispatchGate({
      threadId: childId,
      parentThreadId: b.threadId,
      originPluginId: "gtd-sidebar",
      inputBlocks: [{ type: "text", text: "now over here" }],
    });
    assert.equal(moved.action, "proceed");
    assert.equal(h.service.membership.descendantInitiative(childId), b.initiative.id);
    assert.equal(h.service.membership.roleHint(childId, b.threadId), "agent");
  });
});

describe("initiative service — shared directory workspace", () => {
  it("creates one host/unmanaged environment and reuses it for repository-focused children", async () => {
    const h = makeHarness();
    // This fake will not attach the environment until dispatch is admitted,
    // then delays it for several public thread reads. Polling before recheck
    // would deadlock and exhaust the fixture's five-millisecond deadline.
    h.environmentResolutionDelayReads = 3;
    const { initiative } = await h.service.createInitiative({
      name: "Shared",
      workspaceProjectIds: ["proj_a", "proj_b"],
      workspace: { mode: "shared-directory", hostId: "host_a", rootPath: "/repos" },
    });

    assert.deepEqual(initiative.workspace, {
      mode: "shared-directory",
      hostId: "host_a",
      rootPath: "/repos",
    });
    assert.equal(initiative.primaryEnvironmentId, "env_1");
    assert.equal(h.environmentResolutionReads.get(initiative.coordinatorThreadId), 4);
    assert.equal(h.admissionAnswers.get(initiative.coordinatorThreadId), "coordinator");
    assert.equal(h.store.get(initiative.id)?.primaryEnvironmentId, "env_1");
    assert.deepEqual(h.store.workspaceBindings(initiative.id), [
      { projectId: "proj_a", hostId: "host_a", path: "/repos/proj_a" },
      { projectId: "proj_b", hostId: "host_a", path: "/repos/proj_b" },
    ]);
    assert.deepEqual(h.spawnCalls[0]?.environment, {
      type: "host",
      hostId: "host_a",
      workspace: { type: "unmanaged", path: "/repos" },
    });
    assert.deepEqual(h.spawnCalls[0]?.pluginMetadata, {
      initiativeId: initiative.id,
      focusProjectId: "proj_a",
    });

    await h.service.spawnAgent({
      initiativeId: initiative.id,
      projectId: "proj_b",
      prompt: "work in beta",
    });
    assert.equal(h.spawnCalls[1]?.projectId, "proj_a");
    assert.deepEqual(h.spawnCalls[1]?.environment, {
      type: "reuse",
      environmentId: "env_1",
    });
    assert.deepEqual(h.spawnCalls[1]?.pluginMetadata, {
      initiativeId: initiative.id,
      focusProjectId: "proj_b",
    });
  });

  it("deletes the coordinator and persists nothing when no concrete environment resolves", async () => {
    const h = makeHarness();
    h.omitNextEnvironmentId = true;
    await assert.rejects(
      h.service.createInitiative({
        name: "No environment",
        workspaceProjectIds: ["proj_a", "proj_b"],
        workspace: { mode: "shared-directory", hostId: "host_a", rootPath: "/repos" },
      }),
      /did not resolve within 5ms/,
    );
    assert.equal(h.store.list().length, 0);
    assert.deepEqual(h.deleteCalls, ["thr_1"]);
  });

  it("cleans up a persisted row when native environment provisioning fails", async () => {
    const h = makeHarness();
    h.failEnvironmentProvisioning = true;
    await assert.rejects(
      h.service.createInitiative({
        name: "Provisioning failure",
        workspaceProjectIds: ["proj_a", "proj_b"],
        workspace: { mode: "shared-directory", hostId: "host_a", rootPath: "/repos" },
      }),
      /environment provisioning failed/,
    );
    assert.equal(h.store.list().length, 0);
    assert.deepEqual(h.deleteCalls, ["thr_1"]);
  });

  it("recovers a persisted pending environment after a service reload before child reuse", async () => {
    const h = makeHarness();
    const initiative = h.store.create({
      ...makeInput({
        id: "init_pending",
        coordinatorThreadId: "thr_pending",
      }),
      workspace: { mode: "shared-directory", hostId: "host_a", rootPath: "/repos" },
      workspaceBindings: [
        { projectId: "proj_a", hostId: "host_a", path: "/repos/proj_a" },
        { projectId: "proj_b", hostId: "host_a", path: "/repos/proj_b" },
      ],
      primaryEnvironmentId: null,
    });
    h.addThread({
      id: initiative.coordinatorThreadId,
      projectId: "proj_a",
      status: "starting",
      environmentId: "env_recovered",
    });

    const reloaded = h.reloadService();
    const child = await reloaded.spawnAgent({
      initiativeId: initiative.id,
      projectId: "proj_b",
      prompt: "continue after reload",
    });

    assert.equal(h.store.get(initiative.id)?.primaryEnvironmentId, "env_recovered");
    assert.deepEqual(h.spawnCalls.at(-1)?.environment, {
      type: "reuse",
      environmentId: "env_recovered",
    });
    assert.equal(h.dispatched.has(child.threadId), true);
  });

  it("preserves a visible pending Project when reload recovery times out", async () => {
    const h = makeHarness();
    const initiative = h.store.create({
      ...makeInput({
        id: "init_pending",
        coordinatorThreadId: "thr_pending",
      }),
      workspace: { mode: "shared-directory", hostId: "host_a", rootPath: "/repos" },
      workspaceBindings: [
        { projectId: "proj_a", hostId: "host_a", path: "/repos/proj_a" },
        { projectId: "proj_b", hostId: "host_a", path: "/repos/proj_b" },
      ],
      primaryEnvironmentId: null,
    });
    h.addThread({
      id: initiative.coordinatorThreadId,
      projectId: "proj_a",
      status: "starting",
      environmentId: null,
    });

    const reloaded = h.reloadService();
    await assert.rejects(
      reloaded.spawnAgent({ initiativeId: initiative.id, prompt: "retry later" }),
      /did not resolve within 5ms/,
    );

    assert.equal(h.store.get(initiative.id)?.primaryEnvironmentId, null);
    assert.deepEqual(h.deleteCalls, []);
    assert.equal(h.spawnCalls.length, 0);
  });

  it("persists an assigned environment even if the provider turn then enters error", async () => {
    const h = makeHarness();
    h.environmentStatusOnAttach = "error";
    const { initiative } = await h.service.createInitiative({
      name: "Provider failure after provisioning",
      workspaceProjectIds: ["proj_a", "proj_b"],
      workspace: { mode: "shared-directory", hostId: "host_a", rootPath: "/repos" },
    });
    assert.equal(initiative.primaryEnvironmentId, "env_1");
    assert.equal(h.store.get(initiative.id)?.primaryEnvironmentId, "env_1");
    assert.deepEqual(h.deleteCalls, []);
  });

  it("rejects environment overrides and moved saved checkouts", async () => {
    const h = makeHarness();
    await assert.rejects(
      h.service.createInitiative({
        name: "Override",
        workspaceProjectIds: ["proj_a", "proj_b"],
        workspace: { mode: "shared-directory", hostId: "host_a", rootPath: "/repos" },
        environmentId: "env_other",
      }),
      /overrides are not allowed/,
    );
    assert.equal(h.spawnCalls.length, 0);

    const { initiative } = await h.service.createInitiative({
      name: "Moved",
      workspaceProjectIds: ["proj_a", "proj_b"],
      workspace: { mode: "shared-directory", hostId: "host_a", rootPath: "/repos" },
    });
    h.rewriteValidatedPathsTo = "/repos/replaced";
    await assert.rejects(
      h.service.spawnAgent({ initiativeId: initiative.id, prompt: "work" }),
      /was moved or deleted/,
    );
    assert.equal(h.spawnCalls.length, 1);
  });

  it("requires creation to match the canonical root the user confirmed", async () => {
    const h = makeHarness();
    h.rewriteValidatedRootTo = "/canonical/repos";
    await assert.rejects(
      h.service.createInitiative({
        name: "Changed root",
        workspaceProjectIds: ["proj_a", "proj_b"],
        workspace: { mode: "shared-directory", hostId: "host_a", rootPath: "/repos" },
      }),
      /changed since confirmation/,
    );
    assert.equal(h.spawnCalls.length, 0);
  });
});

describe("initiative service — membership and lifecycle", () => {
  it("resolves descendants through parent ancestry including raw spawns", async () => {
    const h = makeHarness();
    const { initiative, threadId } = await h.service.createInitiative({
      name: "Tree",
      workspaceProjectIds: [],
    });
    h.addThread({ id: "thr_child", parentThreadId: threadId });
    h.addThread({ id: "thr_grand", parentThreadId: "thr_child" });
    h.addThread({ id: "thr_unrelated" });
    assert.equal((await h.service.resolveThread("thr_grand"))?.initiative.id, initiative.id);
    assert.equal((await h.service.resolveThread(threadId))?.role, "coordinator");
    assert.equal(await h.service.resolveThread("thr_unrelated"), null);
  });

  it("spawnAgent rejects deleted, archived, and unbound-coordinator states", async () => {
    const h = makeHarness();
    const { initiative, threadId } = await h.service.createInitiative({
      name: "Guard",
      workspaceProjectIds: ["proj_a"],
    });
    await assert.rejects(
      h.service.spawnAgent({ initiativeId: initiative.id, prompt: "x", projectId: "proj_other" }),
      /not bound/,
    );
    const row = h.rows.get(threadId)!;
    row.deletedAt = Date.now();
    await assert.rejects(
      h.service.spawnAgent({ initiativeId: initiative.id, prompt: "x" }),
      /unavailable/,
    );
    row.deletedAt = null;
    row.archivedAt = Date.now();
    await assert.rejects(
      h.service.spawnAgent({ initiativeId: initiative.id, prompt: "x" }),
      /archived/,
    );
  });

  it("coordinatorSnapshot reports deleted and missing coordinators unavailable", async () => {
    const h = makeHarness();
    const { initiative, threadId } = await h.service.createInitiative({
      name: "Snap",
      workspaceProjectIds: [],
    });
    assert.deepEqual(await h.service.coordinatorSnapshot(initiative), {
      status: "starting",
      available: true,
    });
    h.rows.get(threadId)!.deletedAt = Date.now();
    assert.equal((await h.service.coordinatorSnapshot(initiative)).available, false);
    h.rows.delete(threadId);
    assert.equal((await h.service.coordinatorSnapshot(initiative)).available, false);
  });

  it("rejects attaching another initiative's coordinator", async () => {
    const h = makeHarness();
    const a = await h.service.createInitiative({ name: "A", workspaceProjectIds: [] });
    const b = await h.service.createInitiative({ name: "B", workspaceProjectIds: [] });
    await assert.rejects(
      h.service.attachThread(a.initiative.id, b.threadId),
      /coordinates another initiative/,
    );
  });

  it("rejects reparenting a coordinator ancestor under its own initiative", async () => {
    const h = makeHarness();
    const { initiative, threadId } = await h.service.createInitiative({
      name: "Cycle",
      workspaceProjectIds: [],
    });
    h.addThread({ id: "thr_outer" });
    h.rows.get(threadId)!.parentThreadId = "thr_outer";
    await assert.rejects(
      h.service.attachThread(initiative.id, "thr_outer"),
      /ancestor of the coordinator/,
    );
  });

  it("rejects attaching a thread already claimed by an initiative subtree", async () => {
    const h = makeHarness();
    const a = await h.service.createInitiative({ name: "A", workspaceProjectIds: [] });
    const b = await h.service.createInitiative({ name: "B", workspaceProjectIds: [] });
    h.addThread({ id: "thr_b_kid", parentThreadId: b.threadId });
    // A descendant of B cannot be grafted under A — that would split its
    // subtree's membership across two registries.
    await assert.rejects(
      h.service.attachThread(a.initiative.id, "thr_b_kid"),
      /already belongs to initiative/,
    );
    assert.equal(h.rows.get("thr_b_kid")?.parentThreadId, b.threadId);
  });

  it("attach/detach reparents and the subtree follows the index", async () => {
    const h = makeHarness();
    const { initiative, threadId } = await h.service.createInitiative({
      name: "Attach",
      workspaceProjectIds: [],
    });
    h.addThread({ id: "thr_ext" });
    h.addThread({ id: "thr_ext_child", parentThreadId: "thr_ext" });
    await h.service.attachThread(initiative.id, "thr_ext");
    assert.equal(h.rows.get("thr_ext")?.parentThreadId, threadId);
    assert.equal(h.service.membership.descendantInitiative("thr_ext_child"), initiative.id);
    await assert.rejects(
      h.service.detachThread(initiative.id, threadId),
      /cannot detach a coordinator/,
    );
    await h.service.detachThread(initiative.id, "thr_ext");
    assert.equal(h.rows.get("thr_ext")?.parentThreadId, null);
    assert.equal(h.service.membership.descendantInitiative("thr_ext_child"), null);
  });

  it("lists agents breadth-first with core status, flagging truncation", async () => {
    const h = makeHarness();
    const { initiative, threadId } = await h.service.createInitiative({
      name: "Roster",
      workspaceProjectIds: [],
    });
    h.addThread({ id: "thr_a", parentThreadId: threadId, status: "active" });
    h.addThread({ id: "thr_b", parentThreadId: "thr_a", status: "idle" });
    const { agents, truncated } = await h.service.listAgents(initiative);
    assert.equal(truncated, false);
    assert.deepEqual(
      agents.map((a) => [a.threadId, a.status, a.depth]),
      [
        ["thr_a", "active", 1],
        ["thr_b", "idle", 2],
      ],
    );
  });

  it("does not let a truncated roster evict gate-established membership", async () => {
    const h = makeHarness();
    const { initiative, threadId } = await h.service.createInitiative({
      name: "Big",
      workspaceProjectIds: [],
    });
    // More direct children than the roster cap (512): the UI list flags
    // truncated and the over-cap rows never enter its projection.
    for (let i = 0; i < 513; i++) {
      h.addThread({ id: `thr_c${i}`, parentThreadId: threadId });
    }
    // The gate already admitted and indexed an over-cap member.
    const decision = await h.service.dispatchGate({
      threadId: "thr_c512",
      parentThreadId: threadId,
      originPluginId: "gtd-sidebar",
      inputBlocks: [{ type: "text", text: "hi" }],
    });
    assert.equal(decision.action, "proceed");
    assert.equal(h.service.membership.descendantInitiative("thr_c512"), initiative.id);

    const { truncated } = await h.service.listAgents(initiative);
    assert.equal(truncated, true);
    // The truncated projection must not erase it.
    assert.equal(h.service.membership.descendantInitiative("thr_c512"), initiative.id);
    assert.equal(h.service.membership.roleHint("thr_c512", threadId), "agent");
  });

  it("propagates a list failure instead of reporting an empty roster", async () => {
    const h = makeHarness();
    const { initiative } = await h.service.createInitiative({
      name: "Fail",
      workspaceProjectIds: [],
    });
    const broken = {
      ...h.api,
      list: async () => {
        throw new Error("list blew up");
      },
    };
    const store = h.store;
    const service = createInitiativeService({
      store,
      threads: broken as never,
      projects: {
        async list() {
          return [];
        },
        async get() {
          throw new Error("not used");
        },
      } as never,
      hosts: {
        async get() {
          throw new Error("not used");
        },
      } as never,
      inspectSharedDirectory: async () => {
        throw new Error("not used");
      },
      pluginId: "gtd-sidebar",
      publish: () => {},
      log: { info() {}, warn() {}, error() {} },
      recheckDispatch: async () => {},
    });
    await assert.rejects(service.listAgents(initiative), /list blew up/);
  });
});

describe("initiative service — archive/restore partial failure", () => {
  it("keeps the initiative paused and retryable when a descendant archive fails", async () => {
    const h = makeHarness();
    const { initiative, threadId } = await h.service.createInitiative({
      name: "Arch",
      workspaceProjectIds: [],
    });
    h.addThread({ id: "thr_a1", parentThreadId: threadId });
    h.addThread({ id: "thr_a2", parentThreadId: threadId });
    h.failArchives.add("thr_a2");

    await assert.rejects(h.service.setArchived(initiative.id, true), /archive incomplete/);
    // Paused despite the partial failure — the flag landed before archiving.
    assert.notEqual(h.store.get(initiative.id)?.archivedAt, null);
    assert.notEqual(h.rows.get(threadId)?.archivedAt, null);
    assert.notEqual(h.rows.get("thr_a1")?.archivedAt, null);
    assert.equal(h.rows.get("thr_a2")?.archivedAt, null);

    // Retry converges over only the remaining thread — the coordinator and
    // thr_a1 are already archived, so they are not re-mutated.
    h.failArchives.clear();
    const updated = await h.service.setArchived(initiative.id, true);
    assert.notEqual(updated.archivedAt, null);
    assert.notEqual(h.rows.get("thr_a2")?.archivedAt, null);
    assert.equal(h.archiveCalls.filter((id) => id === threadId).length, 1);
    assert.equal(h.archiveCalls.filter((id) => id === "thr_a2").length, 2);
  });

  it("keeps the initiative archived when coordinator restore fails", async () => {
    const h = makeHarness();
    const { initiative, threadId } = await h.service.createInitiative({
      name: "Rest",
      workspaceProjectIds: [],
    });
    h.addThread({ id: "thr_r1", parentThreadId: threadId });
    await h.service.setArchived(initiative.id, true);
    h.failUnarchives.add(threadId);
    await assert.rejects(h.service.setArchived(initiative.id, false), /restore incomplete/);
    // Registry flag stayed set — subscriptions remain paused.
    assert.notEqual(h.store.get(initiative.id)?.archivedAt, null);
    // The descendant was restored; only the coordinator failed.
    assert.equal(h.rows.get("thr_r1")?.archivedAt, null);
    h.failUnarchives.clear();
    const restored = await h.service.setArchived(initiative.id, false);
    assert.equal(restored.archivedAt, null);
  });

  it("reaches live grandchildren behind an archived parent on archive", async () => {
    const h = makeHarness();
    const { initiative, threadId } = await h.service.createInitiative({
      name: "Mixed",
      workspaceProjectIds: [],
    });
    // Mixed state before the archive pass: mid-level child already archived
    // (a manual settle), its live grandchild underneath.
    h.addThread({ id: "thr_mid", parentThreadId: threadId, archivedAt: 123 });
    h.addThread({ id: "thr_deep", parentThreadId: "thr_mid" });
    h.addThread({ id: "thr_live", parentThreadId: threadId });

    await h.service.setArchived(initiative.id, true);
    // The traversal crossed the archived parent to reach thr_deep.
    assert.notEqual(h.rows.get("thr_deep")?.archivedAt, null);
    assert.notEqual(h.rows.get("thr_live")?.archivedAt, null);
    // thr_mid was already archived — mutated only if needed.
    assert.equal(h.archiveCalls.filter((id) => id === "thr_mid").length, 0);

    // And a partial restore converges over only the still-archived rows.
    h.failUnarchives.add("thr_deep");
    await assert.rejects(h.service.setArchived(initiative.id, false), /restore incomplete/);
    assert.notEqual(h.store.get(initiative.id)?.archivedAt, null);
    assert.equal(h.rows.get("thr_live")?.archivedAt, null);
    assert.notEqual(h.rows.get("thr_deep")?.archivedAt, null);
    h.failUnarchives.clear();
    await h.service.setArchived(initiative.id, false);
    assert.equal(h.rows.get("thr_deep")?.archivedAt, null);
    // The coordinator's second unarchive is skipped: it already restored.
    assert.equal(h.unarchiveCalls.filter((id) => id === threadId).length, 1);
  });

  it("fails restore closed when the coordinator was deleted", async () => {
    const h = makeHarness();
    const { initiative, threadId } = await h.service.createInitiative({
      name: "Gone",
      workspaceProjectIds: [],
    });
    await h.service.setArchived(initiative.id, true);
    h.rows.get(threadId)!.deletedAt = Date.now();
    await assert.rejects(h.service.setArchived(initiative.id, false), /unavailable/);
    assert.notEqual(h.store.get(initiative.id)?.archivedAt, null);
  });
});

describe("initiative service — native lifecycle mirroring", () => {
  it("pauses and resumes with native coordinator archive/restore", async () => {
    const h = makeHarness();
    const { initiative, threadId } = await h.service.createInitiative({
      name: "Native",
      workspaceProjectIds: [],
    });
    // User archives the coordinator through an ordinary surface.
    h.service.noteNativeThreadState(threadId, "archived");
    assert.notEqual(h.store.get(initiative.id)?.archivedAt, null);
    // Descendant events are ignored — only the coordinator owns the flag.
    const publishes = h.published.length;
    h.service.noteNativeThreadState("thr_random", "archived");
    assert.equal(h.published.length, publishes);
    // Restore through the same surface resumes the initiative.
    h.service.noteNativeThreadState(threadId, "unarchived");
    assert.equal(h.store.get(initiative.id)?.archivedAt, null);
    // Deletion publishes so UIs surface "unavailable" — never a respawn.
    h.service.noteNativeThreadState(threadId, "deleted");
    assert.notEqual(h.store.get(initiative.id), null);
    assert.equal(
      h.published.some(
        (p) =>
          p.channel === INITIATIVES_CHANNEL &&
          (p.payload as { initiativeId?: string }).initiativeId === initiative.id,
      ),
      true,
    );
  });

  it("ignores its own archive-loop events", async () => {
    const h = makeHarness();
    const { initiative, threadId } = await h.service.createInitiative({
      name: "Loop",
      workspaceProjectIds: [],
    });
    // Service-driven archive flips the flag BEFORE thread ops; the native
    // event arriving mid-loop is a no-op, not a double toggle.
    await h.service.setArchived(initiative.id, true);
    h.service.noteNativeThreadState(threadId, "archived");
    assert.notEqual(h.store.get(initiative.id)?.archivedAt, null);
  });
});

describe("initiative service — context doc boundary", () => {
  it("publishes on successful writes and deletes only", async () => {
    const h = makeHarness();
    const { initiative } = await h.service.createInitiative({
      name: "Pub",
      workspaceProjectIds: [],
    });
    const before = h.published.length;
    h.service.writeContextDoc({
      initiativeId: initiative.id,
      path: "a.md",
      content: "v1",
      expectedRevision: 0,
    });
    h.service.writeContextDoc({
      initiativeId: initiative.id,
      path: "a.md",
      content: "conflict",
      expectedRevision: 99,
    });
    h.service.deleteContextDoc(initiative.id, "a.md");
    h.service.deleteContextDoc(initiative.id, "a.md"); // already gone — no publish
    const channelPublishes = h.published
      .slice(before)
      .filter((p) => p.channel === INITIATIVES_CHANNEL);
    assert.equal(channelPublishes.length, 2);
    assert.deepEqual(channelPublishes[0]?.payload, {
      initiativeId: initiative.id,
      path: "a.md",
    });
    assert.deepEqual(channelPublishes[1]?.payload, {
      initiativeId: initiative.id,
      path: "a.md",
    });
  });
});

describe("channel constants", () => {
  it("shares the automation module's subscription channel", () => {
    assert.equal(INITIATIVES_CHANNEL, "initiatives");
    assert.equal(SUBSCRIPTIONS_CHANNEL, "initiative-subscriptions");
    assert.equal(SUBSCRIPTIONS_CHANNEL, SUBSCRIPTIONS_REALTIME_CHANNEL);
  });
});
