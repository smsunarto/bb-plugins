import assert from "node:assert/strict";
import { describe, test } from "bun:test";
import { defineCli } from "@get-bb/plugin-sdk";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { createProjectTitleRulesCache } from "../lib/project-title-rules.ts";
import { registerThreadNaming } from "../thread-naming-server.ts";

const THREAD_ID = "thr_target";
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(options: { enabled?: boolean; projectRules?: string; title?: string } = {}) {
  const updates: { threadId: string; title: string }[] = [];
  let fileReads = 0;
  // The thread's latest user request, as bb records it.
  let latestRequestSeq = 1;
  const thread = makeThreadResponse({
    id: THREAD_ID,
    projectId: "proj_1",
    environmentId: "env_1",
    title: options.title ?? "Fix login",
    status: "active",
  });
  const host = createFakePluginHost({
    pluginId: "gtd-sidebar",
    agentSkillIds: ["configure-gtd-naming"],
    settings: { automaticallyNameThreads: options.enabled ?? true },
    sdk: {
      subscribe: () => () => {},
      environments: {
        get: async () => ({ id: "env_1", hostId: "host_1", status: "ready", path: "/workspace" }),
      },
      files: {
        read: async () => {
          fileReads += 1;
          if (options.projectRules === undefined) {
            throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
          }
          return {
            content: options.projectRules,
            contentEncoding: "utf8",
            modifiedAtMs: 1,
            sha256: "abc",
            sizeBytes: options.projectRules.length,
          };
        },
      },
      threads: {
        get: async () => thread,
        events: {
          list: async (args) => {
            const { order } = args as { order?: string };
            if (order !== "desc") return [];
            return [{ seq: latestRequestSeq, type: "client/turn/requested", data: {} }] as never;
          },
        },
        update: async (args) => {
          const { threadId, title } = args as { threadId: string; title: string };
          updates.push({ threadId, title });
          thread.title = title;
          return thread;
        },
      },
    },
  });
  const settings = host.bb.settings.define({
    automaticallyNameThreads: {
      type: "boolean",
      label: "Automatically name threads",
      description: "test",
      default: false,
    },
  });
  const { renameCommand } = registerThreadNaming(host.bb, {
    settings,
    inference: { complete: async () => "Generated title" },
  });
  host.bb.cli.register(
    defineCli({ name: "gtd-sidebar", summary: "test", commands: { rename: renameCommand } }),
  );
  const configure = (overrides: Parameters<typeof makePluginAgentConfigurationContext>[0] = {}) =>
    host.harness.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        thread: { id: THREAD_ID, parentThreadId: null },
        project: { id: "proj_1" },
        environment: { id: "env_1" },
        ...overrides,
      }),
    );
  const turn = {
    /** The user sends a request: a new turn starts running. */
    start() {
      latestRequestSeq += 10;
      thread.status = "active";
    },
    /** The turn completes and the thread goes idle. */
    end() {
      thread.status = "idle";
    },
  };
  const rename = (title: string, threadId?: string) =>
    host.harness.runCli(["rename", "--title", title, ...(threadId ? [threadId] : [])], {
      threadId: THREAD_ID,
    } as never);
  return { host, updates, configure, turn, rename, fileReads: () => fileReads };
}

describe("agent rename instructions", () => {
  test("give a root thread the one-call rename command and the project rules", async () => {
    const { configure, fileReads } = setup({ projectRules: "Prefix titles with [API]." });
    await flush();
    const cold = await configure();
    assert.deepEqual(cold.skills, ["configure-gtd-naming"]);
    assert.match(cold.instructions ?? "", /bb gtd-sidebar rename --title "<title>"/u);
    assert.match(
      cold.instructions ?? "",
      /First request:\*\* if you are the agent answering the user's request in this turn, make this command your first tool call/u,
    );
    assert.match(cold.instructions ?? "", /not loaded when this session started/u);
    await flush();
    const warm = await configure();
    assert.match(
      warm.instructions ?? "",
      /Project title rules, from \.agents\/GTD_NAMING\.md:\nPrefix titles with \[API\]\./u,
    );
    assert.match(warm.instructions ?? "", /run no command to read the current title/u);
    await configure();
    assert.equal(fileReads(), 1);
  });

  test("say so when the project has no extra rules", async () => {
    const { configure } = setup();
    await flush();
    await configure();
    await flush();
    assert.match((await configure()).instructions ?? "", /no extra title rules/u);
  });

  test("stay off for child threads, side chats, and when naming is disabled", async () => {
    const enabled = setup();
    await flush();
    for (const overrides of [
      { thread: { id: THREAD_ID, parentThreadId: "thr_parent" } },
      { origin: { kind: "fork" as const, pluginId: "side-chat" } },
    ]) {
      const result = await enabled.configure(overrides);
      assert.equal(result.instructions, null);
      assert.deepEqual(result.skills, ["configure-gtd-naming"]);
    }
    const disabled = setup({ enabled: false });
    await flush();
    assert.equal((await disabled.configure()).instructions, null);
    await disabled.host.harness.setSettings({ automaticallyNameThreads: true });
    assert.notEqual((await disabled.configure()).instructions, null);
  });
});

describe("bb gtd-sidebar rename --title", () => {
  test("sets the agent's title in one call and prints the change", async () => {
    const { host, updates } = setup({ projectRules: "Prefix titles with [API]." });
    const result = await host.harness.runCli(["rename", "--title", "  [API] Add CSV export  "], {
      threadId: THREAD_ID,
    } as never);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(updates, [{ threadId: THREAD_ID, title: "[API] Add CSV export" }]);
    assert.match(result.stdout, /^Renamed "Fix login" → "\[API\] Add CSV export"\n/u);
    assert.match(result.stdout, /Prefix titles with \[API\]\./u);
  });

  test("rejects a bare title and a title with no words", async () => {
    const { host, updates } = setup();
    const bare = await host.harness.runCli(["rename", "Add CSV export"], {
      threadId: THREAD_ID,
    } as never);
    assert.notEqual(bare.exitCode, 0);
    assert.match(bare.stderr, /Pass the title with --title/u);
    const empty = await host.harness.runCli(["rename", "--title", "🛠️ [API]"], {
      threadId: THREAD_ID,
    } as never);
    assert.notEqual(empty.exitCode, 0);
    assert.match(empty.stderr, /at least one letter or digit/u);
    assert.deepEqual(updates, []);
  });
});

describe("agent rename guard", () => {
  // Codex's memory-consolidation agent renamed thr_8w7ry3d5he 46s after its turn completed.
  test("refuses a rename from a background agent 46s after the turn ended", async () => {
    const { updates, turn, rename } = setup();
    const first = await rename("Track match status with Agones");
    assert.equal(first.exitCode, 0, first.stderr);
    turn.end();
    // 46s later, with no turn running.
    const late = await rename("Consolidate agent memories");
    assert.equal(late.exitCode, 0, late.stderr);
    assert.match(late.stdout, /no turn is running/u);
    assert.deepEqual(
      updates.map((update) => update.title),
      ["Track match status with Agones"],
    );
  });

  test("refuses a second rename in one user turn and allows one in the next", async () => {
    const { updates, turn, rename } = setup();
    assert.equal((await rename("Track match status with Agones")).exitCode, 0);
    const second = await rename("Can Agones track match status?");
    assert.equal(second.exitCode, 0, second.stderr);
    assert.match(second.stdout, /already renamed/u);
    turn.end();
    turn.start();
    assert.equal((await rename("Add Agones health checks")).exitCode, 0);
    assert.deepEqual(
      updates.map((update) => update.title),
      ["Track match status with Agones", "Add Agones health checks"],
    );
  });

  test("releases the slot when a title is rejected, so the agent can fix it", async () => {
    const { updates, rename } = setup();
    assert.notEqual((await rename("🛠️ [API]")).exitCode, 0);
    assert.equal((await rename("[API] Add CSV export")).exitCode, 0);
    assert.deepEqual(updates, [{ threadId: THREAD_ID, title: "[API] Add CSV export" }]);
  });

  // BBP-24 review: a cold session's rules printout must not reopen a second rename.
  test("allows one rename per request even when the session started before the rules loaded", async () => {
    const { configure, updates, rename } = setup({ projectRules: "Prefix titles with [API]." });
    await flush();
    const cold = await configure();
    assert.match(cold.instructions ?? "", /not loaded when this session started/u);
    const first = await rename("[API] Original task title");
    assert.match(first.stdout, /Prefix titles with \[API\]\./u);
    const second = await rename("Consolidate agent memories");
    assert.equal(second.exitCode, 0, second.stderr);
    assert.match(second.stdout, /already renamed/u);
    assert.deepEqual(
      updates.map((update) => update.title),
      ["[API] Original task title"],
    );
  });

  // BBP-24 review: both calls passed the check before either recorded its rename.
  test("lets only one of two concurrent renames in one request through", async () => {
    const { updates, rename } = setup();
    const results = await Promise.all([
      rename("Original task title"),
      rename("Consolidate agent memories"),
    ]);
    assert.deepEqual(
      results.map((result) => result.exitCode),
      [0, 0],
    );
    assert.equal(results.filter((result) => /already renamed/u.test(result.stdout)).length, 1);
    assert.equal(updates.length, 1);
  });

  test("guards a rename that names its own thread by id", async () => {
    const { updates, turn, rename } = setup();
    turn.end();
    const result = await rename("Consolidate agent memories", THREAD_ID);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /no turn is running/u);
    assert.deepEqual(updates, []);
  });

  test("leaves renames of another thread and title regeneration unguarded", async () => {
    const { updates, turn, host, rename } = setup();
    turn.end();
    const child = await rename("Add CSV export", "thr_child");
    assert.equal(child.exitCode, 0, child.stderr);
    assert.deepEqual(updates, [{ threadId: "thr_child", title: "Add CSV export" }]);
    const regenerated = await host.harness.runCli(["rename"], { threadId: THREAD_ID } as never);
    assert.match(regenerated.stderr, /no user request to name/u);
  });
});

describe("createProjectTitleRulesCache", () => {
  test("reads once per project, retries a not-ready workspace, and refreshes when stale", async () => {
    let clock = 0;
    const reads: string[] = [];
    let answer: string | null = null;
    const cache = createProjectTitleRulesCache(
      async (environmentId) => {
        reads.push(environmentId);
        return answer;
      },
      { now: () => clock },
    );
    assert.equal(cache.peek("proj_1", "env_a"), undefined);
    assert.equal(cache.peek("proj_1", "env_a"), undefined);
    await flush();
    assert.deepEqual(reads, ["env_a"]);
    answer = "Use [GTD].";
    assert.equal(cache.peek("proj_1", "env_b"), undefined);
    await flush();
    assert.equal(cache.peek("proj_1", "env_c"), "Use [GTD].");
    assert.deepEqual(reads, ["env_a", "env_b"]);
    clock = 10 * 60_000;
    assert.equal(cache.peek("proj_1", "env_c"), "Use [GTD].");
    await flush();
    assert.deepEqual(reads, ["env_a", "env_b", "env_c"]);
    answer = "";
    cache.peek("proj_2", "env_d");
    await flush();
    assert.equal(cache.peek("proj_2", null), "");
  });
});
