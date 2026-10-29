import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import { createStore } from "../lib/db";
import type { GhClient, GhComment } from "../lib/gh";
import { buildHeader, buildMarker } from "../lib/marker";
import type { PullRequest, Run } from "../lib/types";
import plugin from "../server";

// GitHub as the watcher and the verifier see it. Replaced for the whole file,
// so a test seeds open PRs and comments instead of shelling out to `gh`.
const github = vi.hoisted(() => ({
  pullRequests: [] as PullRequest[],
  issueComments: [] as GhComment[],
  /** Live verification waits here first, so a test can hold a run mid-verify. */
  gate: Promise.resolve(),
}));

vi.mock("../lib/gh", () => ({
  createGhClient: (): GhClient => ({
    listOpenPullRequests: async () => github.pullRequests,
    getPullRequest: async () => {
      throw new Error("not stubbed");
    },
    listOpenIssueNumbers: async () => [],
    getIssue: async () => {
      throw new Error("not stubbed");
    },
    listFiles: async () => [],
    listIssueComments: async () => {
      await github.gate;
      return github.issueComments;
    },
    listReviewComments: async () => [],
    listReviews: async () => [],
    listRecentIssueComments: async () => [],
    listRecentReviewComments: async () => [],
    authenticatedLogin: async () => "slopcop-bot",
  }),
}));

/** A run whose review thread is still running. */
function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "run_1",
    ruleId: "rule_settle",
    ruleName: "settle",
    repo: "example/example",
    targetKind: "pull_request",
    prNumber: 7,
    prTitle: "Settle",
    prAuthor: "dana",
    headSha: "abc123",
    trigger: "manual",
    triggerEventId: null,
    status: "reviewing",
    mode: "shadow",
    detail: null,
    threadId: "thr_1",
    commentCount: 0,
    startedAt: Date.now(),
    finishedAt: null,
    ...overrides,
  };
}

/** A review body attributed by marker to `run_<name>`. */
function review(name: string): string {
  return `${buildHeader("summary", "settle")}\n\nLooks fine.\n\n${buildMarker({
    rule: "settle",
    run: `run_${name}`,
    sha: "abc123",
    kind: "summary",
  })}`;
}

/** An open, ready PR from a trusted author, posted after the rule was saved. */
function makePullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    kind: "pull_request",
    number: 2,
    title: "Add retries",
    body: "",
    createdAt: Date.now(),
    isDraft: false,
    headRefOid: "def456",
    baseRefName: "main",
    author: { login: "dana" },
    authorAssociation: "MEMBER",
    labels: [],
    files: [],
    isCrossRepository: false,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

it("loads the fork with no rules and saves a disabled rule without dispatching it", async () => {
  let { bb, harness } = createFakePluginHost({ pluginId: "slopcop" });
  try {
    await plugin(bb);
    expect(await harness.behavior.callRpc("listRules", null)).toEqual({ rules: [] });
    await harness.behavior.callRpc("saveRule", {
      id: null,
      rule: { name: "Fork smoke check", repo: "example/example", enabled: false },
    });
    const edited = await harness.behavior.runCli([
      "rules",
      "edit",
      "Fork smoke check",
      "--paths",
      "src/**",
      "--trigger",
      "new_issue",
    ]);
    expect(edited, edited.stderr).toMatchObject({ exitCode: 0 });
    ({ harness } = await harness.lifecycle.reload(plugin));
    expect(await harness.behavior.callRpc("listRules", null)).toMatchObject({
      rules: [
        {
          name: "Fork smoke check",
          enabled: false,
          mode: "shadow",
          triggers: ["new_issue"],
          conditions: [{ kind: "paths", globs: ["src/**"] }],
        },
      ],
    });
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("documents compound command usage and rejects unrelated options", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "slopcop" });
  try {
    await plugin(bb);
    const help = await harness.behavior.runCli(["rules", "--help"]);
    expect(help.stdout).toContain("rules enable|disable|rm <rule>");
    const invalid = await harness.behavior.runCli(["status", "--force"]);
    expect(invalid.exitCode).not.toBe(0);
    const missing = await harness.behavior.runCli(["check", "some-rule"]);
    expect(missing.exitCode).not.toBe(0);
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("adds, persists, replaces and clears excluded PR authors without dropping other filters", async () => {
  let { bb, harness } = createFakePluginHost({ pluginId: "slopcop" });
  try {
    await plugin(bb);
    const { rule } = await harness.behavior.callRpc("saveRule", {
      id: null,
      rule: {
        name: "Exclusions",
        repo: "example/example",
        enabled: false,
        conditions: [{ kind: "has_label", labels: ["security"] }],
      },
    });
    const edit = async (...options: string[]) => {
      const result = await harness.behavior.runCli(["rules", "edit", rule.id, ...options]);
      expect(result, result.stderr).toMatchObject({ exitCode: 0 });
    };
    await edit("--exclude-author", "@Dana,DANA,dependabot[bot]");
    ({ harness } = await harness.lifecycle.reload(plugin));
    expect(await harness.behavior.callRpc("listRules", null)).toMatchObject({
      rules: [
        {
          conditions: [
            { kind: "has_label", labels: ["security"] },
            { kind: "exclude_author", logins: ["dana", "dependabot[bot]"] },
          ],
        },
      ],
    });
    await edit("--prompt", "Keep the exclusions.");
    expect(await harness.behavior.callRpc("listRules", null)).toMatchObject({
      rules: [
        {
          conditions: expect.arrayContaining([
            { kind: "exclude_author", logins: ["dana", "dependabot[bot]"] },
          ]),
        },
      ],
    });
    await edit("--exclude-author", "@Other");
    expect(await harness.behavior.callRpc("listRules", null)).toMatchObject({
      rules: [
        {
          conditions: [
            { kind: "has_label", labels: ["security"] },
            { kind: "exclude_author", logins: ["other"] },
          ],
        },
      ],
    });
    await edit("--exclude-author", "");
    expect(await harness.behavior.callRpc("listRules", null)).toMatchObject({
      rules: [
        {
          conditions: [{ kind: "has_label", labels: ["security"] }],
        },
      ],
    });
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("settles cleanly finished review threads and leaves the rest open", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "slopcop",
    sdk: {
      threads: {
        get: ({ threadId }) =>
          makeThreadResponse({
            id: threadId,
            status: threadId === "thr_resumed" ? "active" : "idle",
          }),
        archive: ({ threadId }) => {
          if (threadId === "thr_throws") throw new Error("archive unavailable");
          return { archivedThreadIds: [threadId] };
        },
      },
    },
  });
  try {
    await plugin(bb);
    const store = createStore(bb.storage.database() as never);
    const start = (name: string) =>
      store.insertRun(makeRun({ id: `run_${name}`, threadId: `thr_${name}` }));
    // Settings and the run row are read synchronously or in microtasks, so a
    // recorded outcome also means the settle decision has read the setting.
    const finish = async (name: string, text: string | null) => {
      start(name);
      const thread = makeThreadResponse({ id: `thr_${name}` });
      await (text === null
        ? harness.behavior.emitThreadEvent("thread.failed", { thread, error: "provider error" })
        : harness.behavior.emitThreadEvent("thread.idle", { thread, lastAssistantText: text }));
      await vi.waitFor(() => expect(store.getRun(`run_${name}`)?.status).not.toBe("reviewing"));
      return store.getRun(`run_${name}`)?.status;
    };
    const archived = () =>
      harness.sdk
        .callsTo("threads.archive")
        .map(([args]) => (args as { threadId: string }).threadId);

    expect(await finish("ok", review("ok"))).toBe("shadowed");
    await vi.waitFor(() => expect(archived()).toEqual(["thr_ok"]));

    expect(await finish("empty", "")).toBe("no_comment");
    expect(await finish("failed", null)).toBe("failed");
    expect(await finish("drift", review("someone_else"))).toBe("commented_unmarked");
    expect(await finish("resumed", review("resumed"))).toBe("shadowed");
    expect(await finish("throws", review("throws"))).toBe("shadowed");
    await harness.behavior.setSettings({ settleFinishedThreads: false });
    expect(await finish("kept", review("kept"))).toBe("shadowed");
    await harness.behavior.setSettings({ settleFinishedThreads: true });

    // A later clean run proves the earlier settle decisions have all run.
    expect(await finish("control", review("control"))).toBe("shadowed");
    await vi.waitFor(() => expect(archived()).toContain("thr_control"));
    expect(archived()).toEqual(["thr_ok", "thr_throws", "thr_control"]);
    expect(store.getRun("run_throws")?.status).toBe("shadowed");
    expect(harness.inspection.logEntries).toContainEqual({
      level: "warn",
      message: "could not settle review thread thr_throws: archive unavailable",
    });
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("counts review threads that predate a reload against the concurrency cap", async () => {
  let { bb, harness } = createFakePluginHost({
    pluginId: "slopcop",
    settings: { maxConcurrentReviews: "1" },
  });
  try {
    await plugin(bb);
    await harness.behavior.callRpc("saveRule", {
      id: null,
      rule: {
        name: "cap",
        repo: "example/example",
        request: { projectId: "project-test", providerId: "codex", model: "test-model" },
      },
    });
    createStore(bb.storage.database() as never).insertRun(
      makeRun({ id: "run_stale", threadId: "thr_stale", prNumber: 1 }),
    );
    github.pullRequests = [makePullRequest({ number: 2 })];

    // A reload forgets everything in memory; the row is what survives.
    ({ bb, harness } = await harness.lifecycle.reload(plugin));
    harness.sdk.stub("threads.spawn", () => ({ id: "thr_new" }));
    const store = createStore(bb.storage.database() as never);
    const spawned = () => harness.sdk.callsTo("threads.spawn").length;
    // One watcher pass: wait for its last store write, let it reach the
    // inter-poll timer, then stop it.
    const pollOnce = async (passed: () => void) => {
      const service = harness.behavior.runService("watcher");
      await vi.waitFor(passed);
      await new Promise((resolve) => setTimeout(resolve, 0));
      service.controller.abort();
      await service.done;
    };

    await pollOnce(() => expect(store.isBootstrapped("example/example")).toBe(true));
    expect(spawned()).toBe(0);

    await harness.behavior.emitThreadEvent("thread.failed", {
      thread: makeThreadResponse({ id: "thr_stale" }),
      error: "provider error",
    });
    await vi.waitFor(() => expect(store.getRun("run_stale")?.status).toBe("failed"));
    await pollOnce(() => expect(spawned()).toBe(1));
    expect(store.listRuns().find((run) => run.prNumber === 2)).toMatchObject({
      status: "reviewing",
      threadId: "thr_new",
    });
  } finally {
    github.pullRequests = [];
    await harness.lifecycle.dispose();
  }
});

it("keeps a run under verification from being marked failed by a later thread event", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "slopcop",
    settings: { settleFinishedThreads: false },
  });
  try {
    await plugin(bb);
    const store = createStore(bb.storage.database() as never);
    store.insertRun(makeRun({ id: "run_live", threadId: "thr_live", mode: "live" }));
    let release = () => {};
    github.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    github.issueComments = [
      {
        id: "c1",
        body: review("live"),
        url: null,
        author: "slopcop-bot",
        path: null,
        line: null,
        createdAt: Date.now(),
      },
    ];
    const thread = makeThreadResponse({ id: "thr_live" });

    await harness.behavior.emitThreadEvent("thread.idle", { thread, lastAssistantText: "posted" });
    await harness.behavior.emitThreadEvent("thread.failed", { thread, error: "provider error" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The idle event owns this run; verification is still reading GitHub.
    expect(store.getRun("run_live")?.status).toBe("reviewing");

    release();
    await vi.waitFor(() =>
      expect(store.getRun("run_live")).toMatchObject({ status: "commented", commentCount: 1 }),
    );
  } finally {
    github.gate = Promise.resolve();
    github.issueComments = [];
    await harness.lifecycle.dispose();
  }
});

it("finishes a run whose thread is archived or deleted before it reports", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "slopcop",
    settings: { settleFinishedThreads: false },
  });
  try {
    await plugin(bb);
    const store = createStore(bb.storage.database() as never);
    for (const name of ["archived", "deleted", "done"]) {
      store.insertRun(makeRun({ id: `run_${name}`, threadId: `thr_${name}` }));
    }
    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_done" }),
      lastAssistantText: review("done"),
    });
    await vi.waitFor(() => expect(store.getRun("run_done")?.status).toBe("shadowed"));

    await harness.behavior.emitThreadEvent("thread.archived", {
      thread: makeThreadResponse({ id: "thr_archived", archivedAt: Date.now() }),
    });
    await harness.behavior.emitThreadEvent("thread.deleted", {
      thread: makeThreadResponse({ id: "thr_deleted" }),
    });
    // Settling a finished thread, or any thread SlopCop never spawned, changes nothing.
    await harness.behavior.emitThreadEvent("thread.archived", {
      thread: makeThreadResponse({ id: "thr_done", archivedAt: Date.now() }),
    });
    await harness.behavior.emitThreadEvent("thread.deleted", {
      thread: makeThreadResponse({ id: "thr_not_ours" }),
    });

    await vi.waitFor(() => {
      expect(store.getRun("run_archived")).toMatchObject({
        status: "failed",
        detail: expect.stringContaining("archived"),
      });
      expect(store.getRun("run_deleted")).toMatchObject({
        status: "failed",
        detail: expect.stringContaining("deleted"),
      });
    });
    expect(store.getRun("run_done")?.status).toBe("shadowed");
  } finally {
    await harness.lifecycle.dispose();
  }
});
