// Agent-surface tests: the tools registered through bb.agents, the per-thread
// configure selection, and the synchronous instructions the first session
// reads. Fake bb captures registrations so tests invoke the real callbacks.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Database } from "bun:sqlite";
import type { Database as BetterSqliteDatabase } from "better-sqlite3";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  createInitiativeStore,
  INITIATIVE_MIGRATIONS,
  INITIATIVE_SHARED_DIRECTORY_MIGRATIONS,
} from "../lib/initiative-store.ts";
import { createInitiativeService } from "../lib/initiative-service.ts";
import { registerInitiativeAgents } from "../lib/initiative-tools.ts";
import { INITIATIVE_TOOL_NAMES } from "../lib/initiative-types.ts";

// The store is typed against better-sqlite3, whose .get() returns undefined
// for a missing row; bun:sqlite returns null. This adapter normalizes so the
// tests exercise the production contract instead of bending it.
function makeDb(): BetterSqliteDatabase {
  const inner = new Database(":memory:");
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
  for (const statement of INITIATIVE_MIGRATIONS) db.exec(statement);
  for (const statement of INITIATIVE_SHARED_DIRECTORY_MIGRATIONS) db.exec(statement);
  return db as unknown as BetterSqliteDatabase;
}

const N = INITIATIVE_TOOL_NAMES;

function makeToolsHarness(
  options: { sharedBindings?: { projectId: string; path: string }[] } = {},
) {
  const store = createInitiativeStore(makeDb());
  const sharedBindings = options.sharedBindings;
  const initiative = store.create({
    id: "init_t",
    name: "ToolsProject",
    icon: "T",
    description: "brief",
    coordinatorThreadId: "thr_coord",
    workspace:
      sharedBindings === undefined
        ? { mode: "legacy" }
        : { mode: "shared-directory", hostId: "host_a", rootPath: "/shared" },
    workspaceBindings:
      sharedBindings === undefined
        ? [{ projectId: "proj_a", hostId: null, path: null }]
        : sharedBindings.map((binding) => ({ ...binding, hostId: "host_a" })),
    primaryEnvironmentId: sharedBindings === undefined ? null : "env_shared",
    providerId: null,
    model: null,
    reasoningLevel: null,
  });
  let seq = 0;
  const rows = new Map<
    string,
    {
      id: string;
      parentThreadId: string | null;
      archivedAt: number | null;
      deletedAt: number | null;
      status: string;
    }
  >();
  rows.set("thr_coord", {
    id: "thr_coord",
    parentThreadId: null,
    archivedAt: null,
    deletedAt: null,
    status: "idle",
  });
  const service = createInitiativeService({
    store,
    threads: {
      async spawn(args: { projectId?: string; parentThreadId?: string; title?: string }) {
        const id = `thr_${++seq}`;
        rows.set(id, {
          id,
          parentThreadId: args.parentThreadId ?? null,
          archivedAt: null,
          deletedAt: null,
          status: "pending",
        });
        return { id };
      },
      async send() {
        return { ok: true };
      },
      async get({ threadId }: { threadId: string }) {
        const row = rows.get(threadId);
        if (row === undefined) throw new Error("not found");
        return row;
      },
      async list() {
        return [];
      },
      async update() {
        return {};
      },
      async delete() {
        return {};
      },
      async archive() {
        return {};
      },
      async unarchive() {
        return {};
      },
    } as never,
    projects: {
      async list() {
        return [{ id: "proj_personal", kind: "personal" }];
      },
      async get() {
        throw new Error("not used");
      },
    } as never,
    hosts: {
      async get() {
        return { status: "connected" };
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

  const tools = new Map<
    string,
    {
      parameters: { parse(input: unknown): unknown };
      execute(params: never, ctx: { threadId: string }): Promise<unknown>;
    }
  >();
  const configureCallbacks: ((ctx: {
    thread: { id: string; parentThreadId: string | null };
    pluginMetadata: Record<string, unknown>;
    origin: { pluginId: string | null };
  }) => { tools: string[]; instructions?: string })[] = [];

  const bb = {
    agents: {
      registerTool(reg: never) {
        tools.set((reg as { name: string }).name, reg as never);
      },
      configure(cb: never) {
        configureCallbacks.push(cb as never);
      },
      contributeInstructions() {},
    },
    ui: {
      registerMentionProvider() {},
    },
  };

  const engineCalls: Record<string, unknown>[] = [];
  const engineDeletes: string[] = [];
  const subscriptionRows = new Map<string, { id: string; initiativeId: string }>();
  registerInitiativeAgents(bb as unknown as BbPluginApi, {
    features: { projects: () => true, subscriptions: () => true },
    service,
    store,
    engine: {
      upsertSubscription(input: Record<string, unknown>) {
        engineCalls.push(input);
        return input as never;
      },
      deleteSubscription(id: string) {
        engineDeletes.push(id);
        subscriptionRows.delete(id);
      },
      async runNow() {
        return "ran" as const;
      },
    },
    subscriptions: {
      get: (id: string) => (subscriptionRows.get(id) ?? null) as never,
      list: () => [],
      remove: () => {},
    },
    threads: { async send() {} } as never,
    pluginId: "gtd-sidebar",
  });

  return {
    store,
    service,
    initiative,
    tools,
    rows,
    configureCallbacks,
    engineCalls,
    engineDeletes,
    subscriptionRows,
    configureFor(
      threadId: string,
      parentThreadId: string | null,
      originPluginId: string | null = "gtd-sidebar",
      pluginMetadata: Record<string, unknown> = {},
    ) {
      return configureCallbacks[0]?.({
        thread: { id: threadId, parentThreadId },
        pluginMetadata,
        origin: { pluginId: originPluginId },
      });
    },
  };
}

describe("initiative agent tools — availability and instructions", () => {
  it("configure gives the coordinator the full delegation set", () => {
    const h = makeToolsHarness();
    // roleHint consults coordinatorIds — seeded from the store at service
    // construction — the same answer the first session gets.
    const selection = h.configureFor(h.initiative.coordinatorThreadId, null, null);
    assert.deepEqual(
      new Set(selection?.tools),
      new Set([
        N.spawnAgent,
        N.listAgents,
        N.messageAgent,
        N.contextList,
        N.contextRead,
        N.contextWrite,
        N.contextDelete,
        N.workspaceInfo,
        N.subscriptionList,
        N.subscriptionUpsert,
        N.subscriptionDelete,
      ]),
    );
  });

  it("configure gives descendants context tools only", () => {
    const h = makeToolsHarness();
    const initiative = h.initiative;
    // Direct child of the coordinator: roleHint resolves through the
    // coordinator set — the same answer the first session gets.
    const selection = h.configureFor("thr_child", initiative.coordinatorThreadId);
    assert.deepEqual(
      new Set(selection?.tools),
      new Set([N.contextList, N.contextRead, N.contextWrite, N.contextDelete, N.workspaceInfo]),
    );
  });

  it("configure gives unrelated threads nothing", async () => {
    const h = makeToolsHarness();
    const selection = h.configureFor("thr_random", null, "other-plugin");
    assert.deepEqual(selection?.tools, []);
  });

  it("configures coordinator instructions naming the project and its tools", () => {
    const h = makeToolsHarness();
    const initiative = h.initiative;
    const text = h.configureFor(initiative.coordinatorThreadId, null)?.instructions ?? null;
    assert.ok(text !== null && text.includes("ToolsProject"));
    assert.ok(text.includes(N.spawnAgent));
    assert.ok(text.includes(N.contextWrite));
    assert.ok((text?.length ?? 0) <= 4096);
  });

  it("configures agent instructions for an indexed descendant", async () => {
    const h = makeToolsHarness();
    const initiative = h.initiative;
    // The thread row exists before its first dispatch (core creates it
    // unhooked) — then the gate walks its ancestry to index it.
    h.rows.set("thr_kid", {
      id: "thr_kid",
      parentThreadId: initiative.coordinatorThreadId,
      archivedAt: null,
      deletedAt: null,
      status: "pending",
    });
    const decision = await h.service.dispatchGate({
      threadId: "thr_kid",
      parentThreadId: initiative.coordinatorThreadId,
      originPluginId: "gtd-sidebar",
      inputBlocks: [{ type: "text", text: "task" }],
    });
    assert.equal(decision.action, "proceed");
    const text = h.configureFor("thr_kid", initiative.coordinatorThreadId)?.instructions ?? null;
    assert.ok(text !== null && text.includes("ToolsProject"));
    assert.ok(text.includes(N.contextRead));
  });

  it("keeps required shared scope rules intact for 32 long repository paths", () => {
    const h = makeToolsHarness({
      sharedBindings: Array.from({ length: 32 }, (_, index) => ({
        projectId: `proj_${index}`,
        path: `/shared/${"very-long-directory-name/".repeat(12)}repo-${index}`,
      })),
    });
    const text = h.configureFor(h.initiative.coordinatorThreadId, null)?.instructions ?? "";
    assert.ok(text.length <= 4_000);
    assert.ok(text.includes(N.workspaceInfo));
    assert.ok(text.includes("Search and edit only the exact checkout paths"));
    assert.ok(text.includes("--no-ignore"));
    assert.ok(text.includes("(cd PATH && but status)"));
    assert.ok(!text.includes("Selected repository snapshots:"));
  });

  it("uses validated spawn metadata as the shared agent's repository focus", () => {
    const h = makeToolsHarness({
      sharedBindings: [
        { projectId: "proj_a", path: "/shared/a" },
        { projectId: "proj_b", path: "/shared/b" },
      ],
    });
    h.service.noteThreadCreated({
      id: "thr_shared_child",
      parentThreadId: h.initiative.coordinatorThreadId,
    });
    const focused =
      h.configureFor("thr_shared_child", h.initiative.coordinatorThreadId, "gtd-sidebar", {
        focusProjectId: "proj_b",
      })?.instructions ?? "";
    assert.ok(focused.includes('repository focus is project "proj_b"'));

    const untrusted =
      h.configureFor("thr_shared_child", h.initiative.coordinatorThreadId, "gtd-sidebar", {
        focusProjectId: "proj_unbound",
      })?.instructions ?? "";
    assert.ok(untrusted.includes('repository focus is project "proj_a"'));
  });

  it("context write tool requires expectedRevision and honors CAS", async () => {
    const h = makeToolsHarness();
    const initiative = h.initiative;
    const tool = h.tools.get(N.contextWrite)!;
    assert.throws(() => tool.parameters.parse({ path: "a.md", content: "x" }));
    const coordinatorCtx = {
      threadId: initiative.coordinatorThreadId,
      projectId: "proj_a",
      signal: new AbortController().signal,
    };
    const created = JSON.parse(
      String(
        await tool.execute(
          { path: "a.md", content: "v1", expectedRevision: 0 } as never,
          coordinatorCtx as never,
        ),
      ),
    );
    assert.equal(created.outcome, "written");
    const conflicted = JSON.parse(
      String(
        await tool.execute(
          { path: "a.md", content: "v2", expectedRevision: 0 } as never,
          coordinatorCtx as never,
        ),
      ),
    );
    assert.equal(conflicted.outcome, "conflict");
    assert.equal(conflicted.revision, 1);
  });

  it("subscription upsert validates ownership before touching the engine", async () => {
    const h = makeToolsHarness();
    const a = h.initiative;
    h.store.create({
      id: "init_other",
      name: "Other",
      icon: "",
      description: "",
      coordinatorThreadId: "thr_other_coord",
      workspace: { mode: "legacy" },
      workspaceBindings: [],
      primaryEnvironmentId: null,
      providerId: null,
      model: null,
      reasoningLevel: null,
    });
    h.subscriptionRows.set("sub_foreign", { id: "sub_foreign", initiativeId: "init_other" });
    const tool = h.tools.get(N.subscriptionUpsert)!;
    const ctx = {
      threadId: a.coordinatorThreadId,
      projectId: "proj_a",
      signal: new AbortController().signal,
    };
    await assert.rejects(
      tool.execute(
        {
          subscriptionId: "sub_foreign",
          kind: "schedule",
          label: "x",
          config: { schedule: "once", runAt: Date.now(), prompt: "p" },
        } as never,
        ctx as never,
      ),
      /not found in this project/,
    );
    assert.equal(h.engineCalls.length, 0);
    // And the happy path reaches the engine.
    await tool.execute(
      {
        kind: "schedule",
        label: "daily",
        config: { schedule: "cron", expression: "0 9 * * *", prompt: "check" },
      } as never,
      ctx as never,
    );
    assert.equal(h.engineCalls.length, 1);
    assert.equal(h.engineCalls[0]?.initiativeId, a.id);
    assert.equal(h.engineCalls[0]?.label, "daily");
  });

  it("subscription delete validates ownership before calling the engine", async () => {
    const h = makeToolsHarness();
    const a = h.initiative;
    h.subscriptionRows.set("sub_mine", { id: "sub_mine", initiativeId: a.id });
    h.subscriptionRows.set("sub_foreign", { id: "sub_foreign", initiativeId: "init_other" });
    const tool = h.tools.get(N.subscriptionDelete)!;
    const ctx = {
      threadId: a.coordinatorThreadId,
      projectId: "proj_a",
      signal: new AbortController().signal,
    };
    await assert.rejects(
      tool.execute({ subscriptionId: "sub_foreign" } as never, ctx as never),
      /not found in this project/,
    );
    assert.equal(h.engineDeletes.length, 0);
    await tool.execute({ subscriptionId: "sub_mine" } as never, ctx as never);
    assert.deepEqual(h.engineDeletes, ["sub_mine"]);
  });

  it("spawn tool delegates with the resolved initiative", async () => {
    const h = makeToolsHarness();
    const initiative = h.initiative;
    const tool = h.tools.get(N.spawnAgent)!;
    const result = JSON.parse(
      String(
        await tool.execute(
          { prompt: "work" } as never,
          {
            threadId: initiative.coordinatorThreadId,
            projectId: "proj_a",
            signal: new AbortController().signal,
          } as never,
        ),
      ),
    );
    assert.match(String(result.threadId), /^thr_/);
  });
});
