import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import { createStore } from "../lib/db";
import type { GhClient, GhComment } from "../lib/gh";
import { buildHeader, buildMarker } from "../lib/marker";
import type { PullRequest, Run, TriggerComment } from "../lib/types";
import plugin from "../server";

// GitHub as the watcher and the verifier see it. Replaced for the whole file,
// so a test seeds open PRs and comments instead of shelling out to `gh`.
const github = vi.hoisted(() => ({
  pullRequests: [] as PullRequest[],
  issueComments: [] as GhComment[],
  /** PR conversation comments the watcher scans for review requests. */
  recentIssueComments: [] as TriggerComment[],
  /** How many times live verification has read the issue comments. */
  issueCommentReads: 0,
  /** Live verification waits here first, so a test can hold a run mid-verify. */
  gate: Promise.resolve(),
}));

vi.mock("../lib/gh", async () => {
  const { Effect } = await import("effect");
  return {
    createGhClient: (): GhClient => ({
      listOpenPullRequests: () => Effect.sync(() => github.pullRequests),
      getPullRequest: () => Effect.die(new Error("not stubbed")),
      listOpenIssueNumbers: () => Effect.succeed([]),
      getIssue: () => Effect.die(new Error("not stubbed")),
      listFiles: () => Effect.succeed([]),
      listIssueComments: () =>
        Effect.promise(async () => {
          github.issueCommentReads += 1;
          await github.gate;
          return github.issueComments;
        }),
      listReviewComments: () => Effect.succeed([]),
      listReviews: () => Effect.succeed([]),
      listRecentIssueComments: () => Effect.sync(() => github.recentIssueComments),
      listRecentReviewComments: () => Effect.succeed([]),
      authenticatedLogin: () => Effect.succeed("slopcop-bot"),
    }),
  };
});

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

    // A reload forgets everything in memory; the row is what survives, and
    // its thread is still running.
    ({ bb, harness } = await harness.lifecycle.reload(plugin));
    harness.sdk.stub("threads.get", ({ threadId }: { threadId: string }) =>
      makeThreadResponse({ id: threadId, status: "active" }),
    );
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

it("frees concurrency slots held by review threads that finished while the plugin was down", async () => {
  let { bb, harness } = createFakePluginHost({
    pluginId: "slopcop",
    settings: { maxConcurrentReviews: "2", settleFinishedThreads: false },
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
    const seed = createStore(bb.storage.database() as never);
    for (const [name, prNumber] of [
      ["done", 1],
      ["gone", 2],
      ["busy", 3],
    ] as const) {
      seed.insertRun(makeRun({ id: `run_${name}`, threadId: `thr_${name}`, prNumber }));
    }
    github.pullRequests = [makePullRequest({ number: 4 }), makePullRequest({ number: 5 })];

    // While no plugin was listening, one thread finished, one was deleted and
    // one kept running. No event will ever arrive for any of them.
    ({ bb, harness } = await harness.lifecycle.reload(plugin));
    harness.sdk.stub("threads.get", ({ threadId }: { threadId: string }) => {
      if (threadId === "thr_gone") {
        throw Object.assign(new Error("HTTP 404: Thread not found"), {
          code: "thread_not_found",
          status: 404,
        });
      }
      return makeThreadResponse({
        id: threadId,
        status: threadId === "thr_busy" ? "active" : "idle",
      });
    });
    harness.sdk.stub("threads.output", () => ({ output: review("done") }));
    harness.sdk.stub("threads.spawn", () => ({ id: "thr_new" }));
    const store = createStore(bb.storage.database() as never);

    const service = harness.behavior.runService("watcher");
    await vi.waitFor(() => expect(store.isBootstrapped("example/example")).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    service.controller.abort();
    await service.done;

    expect(store.getRun("run_done")?.status).toBe("shadowed");
    expect(store.getRun("run_gone")).toMatchObject({
      status: "failed",
      detail: expect.stringContaining("no longer exists"),
    });
    expect(store.getRun("run_busy")?.status).toBe("reviewing");
    // Two slots, one still held by the running thread: the first pass
    // dispatches exactly one of the two waiting PRs.
    expect(harness.sdk.callsTo("threads.spawn")).toHaveLength(1);
  } finally {
    github.pullRequests = [];
    await harness.lifecycle.dispose();
  }
});

/**
 * Starts a watcher pass whose thread spawn is held, stops the watcher while
 * the spawn is in flight, then lets the spawn finish.
 */
async function stopDuringSpawn(harness: ReturnType<typeof createFakePluginHost>["harness"]) {
  let finishSpawn = () => {};
  harness.sdk.stub(
    "threads.spawn",
    () =>
      new Promise((resolve) => {
        finishSpawn = () => resolve({ id: "thr_first" });
      }),
  );
  const service = harness.behavior.runService("watcher");
  await vi.waitFor(() => expect(harness.sdk.callsTo("threads.spawn")).toHaveLength(1));
  service.controller.abort();
  finishSpawn();
  await service.done;
}

it("records a ready PR the watcher stopped mid-dispatch, so a later push does not review it again", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "slopcop" });
  try {
    await plugin(bb);
    await harness.behavior.callRpc("saveRule", {
      id: null,
      rule: {
        name: "ready",
        repo: "example/example",
        dedupe: "once_per_head_sha",
        request: { projectId: "project-test", providerId: "codex", model: "test-model" },
      },
    });
    const store = createStore(bb.storage.database() as never);
    harness.sdk.stub("threads.get", ({ threadId }: { threadId: string }) =>
      makeThreadResponse({ id: threadId, status: "active" }),
    );
    // The first pass records the PR while it is still a draft.
    github.pullRequests = [makePullRequest({ isDraft: true, headRefOid: "sha_a" })];
    let service = harness.behavior.runService("watcher");
    await vi.waitFor(() => expect(store.isBootstrapped("example/example")).toBe(true));
    service.controller.abort();
    await service.done;

    // Marked ready: the next pass dispatches it, and bb stops the watcher mid-spawn.
    github.pullRequests = [makePullRequest({ headRefOid: "sha_a" })];
    await stopDuringSpawn(harness);
    expect(store.getSeen("example/example", 2)).toEqual({ headSha: "sha_a", wasDraft: false });

    // A push is a new head, not a second ready-for-review edge.
    github.pullRequests = [makePullRequest({ headRefOid: "sha_b" })];
    harness.sdk.stub("threads.spawn", () => ({ id: "thr_again" }));
    service = harness.behavior.runService("watcher");
    await vi.waitFor(() => expect(store.getSeen("example/example", 2)?.headSha).toBe("sha_b"));
    service.controller.abort();
    await service.done;
    expect(harness.sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect(store.listRuns()).toMatchObject([{ status: "reviewing", threadId: "thr_first" }]);
  } finally {
    github.pullRequests = [];
    await harness.lifecycle.dispose();
  }
});

it("finishes a review request the watcher stopped mid-dispatch, so a later push does not review it again", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "slopcop" });
  try {
    await plugin(bb);
    await harness.behavior.callRpc("saveRule", {
      id: null,
      rule: {
        name: "on request",
        repo: "example/example",
        triggers: ["comment_matches"],
        commentKeywords: ["/review"],
        dedupe: "once_per_head_sha",
        request: { projectId: "project-test", providerId: "codex", model: "test-model" },
      },
    });
    const store = createStore(bb.storage.database() as never);
    harness.sdk.stub("threads.get", ({ threadId }: { threadId: string }) =>
      makeThreadResponse({ id: threadId, status: "active" }),
    );
    github.pullRequests = [makePullRequest({ headRefOid: "sha_a" })];
    github.recentIssueComments = [
      {
        id: "c1",
        source: "issue",
        repo: "example/example",
        prNumber: 2,
        body: "/review please",
        url: null,
        author: "dana",
        authorAssociation: "MEMBER",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];

    await stopDuringSpawn(harness);
    expect(store.listPendingCommentEvents("example/example")).toEqual([]);

    // GitHub still lists the comment, and the PR has a new head.
    github.pullRequests = [makePullRequest({ headRefOid: "sha_b" })];
    harness.sdk.stub("threads.spawn", () => ({ id: "thr_again" }));
    const service = harness.behavior.runService("watcher");
    await vi.waitFor(() => expect(store.isBootstrapped("example/example")).toBe(true));
    service.controller.abort();
    await service.done;
    expect(harness.sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect(store.listRuns()).toMatchObject([{ status: "reviewing", threadId: "thr_first" }]);
  } finally {
    github.pullRequests = [];
    github.recentIssueComments = [];
    await harness.lifecycle.dispose();
  }
});

it("archives a finished review thread when the watcher stops after recording its outcome", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "slopcop" });
  try {
    await plugin(bb);
    const store = createStore(bb.storage.database() as never);
    // The thread finished while nothing listened, so the first pass settles it.
    store.insertRun(makeRun({ id: "run_done", threadId: "thr_done" }));
    // Settling reads the thread a second time before archiving it; that read is held.
    let reads = 0;
    let finishRead = () => {};
    harness.sdk.stub("threads.get", ({ threadId }: { threadId: string }) => {
      reads += 1;
      if (reads === 1) return makeThreadResponse({ id: threadId });
      return new Promise((resolve) => {
        finishRead = () => resolve(makeThreadResponse({ id: threadId }));
      });
    });
    harness.sdk.stub("threads.output", () => ({ output: review("done") }));
    harness.sdk.stub("threads.archive", ({ threadId }: { threadId: string }) => ({
      archivedThreadIds: [threadId],
    }));

    const service = harness.behavior.runService("watcher");
    await vi.waitFor(() => expect(reads).toBe(2));
    // The run is recorded, so no later pass takes it up again.
    expect(store.getRun("run_done")?.status).toBe("shadowed");
    service.controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));
    finishRead();
    await service.done;

    expect(harness.sdk.callsTo("threads.archive")).toEqual([[{ threadId: "thr_done" }]]);
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("finishes a claimed run whose verification a reload interrupted", async () => {
  let { bb, harness } = createFakePluginHost({
    pluginId: "slopcop",
    settings: { settleFinishedThreads: false },
  });
  try {
    await plugin(bb);
    createStore(bb.storage.database() as never).insertRun(
      makeRun({ id: "run_live", threadId: "thr_live", mode: "live" }),
    );
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
    // The idle event claims the run, then GitHub never answers this incarnation.
    github.gate = new Promise(() => {});
    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_live" }),
      lastAssistantText: "posted",
    });

    github.gate = Promise.resolve();
    ({ bb, harness } = await harness.lifecycle.reload(plugin));
    const store = createStore(bb.storage.database() as never);
    expect(store.getRun("run_live")).toMatchObject({
      status: "reviewing",
      finishedAt: expect.any(Number),
    });
    harness.sdk.stub("threads.get", ({ threadId }: { threadId: string }) =>
      makeThreadResponse({ id: threadId }),
    );
    harness.sdk.stub("threads.output", () => ({ output: "posted" }));

    const service = harness.behavior.runService("watcher");
    await vi.waitFor(() =>
      expect(store.getRun("run_live")).toMatchObject({ status: "commented", commentCount: 1 }),
    );
    service.controller.abort();
    await service.done;
  } finally {
    github.gate = Promise.resolve();
    github.issueComments = [];
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

it("leaves a run a thread event is still verifying to that event when a poll pass runs", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "slopcop",
    settings: { settleFinishedThreads: false },
  });
  try {
    await plugin(bb);
    const store = createStore(bb.storage.database() as never);
    store.insertRun(makeRun({ id: "run_live", threadId: "thr_live", mode: "live" }));
    store.insertRun(makeRun({ id: "run_gone", threadId: "thr_gone" }));
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
    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_live" }),
      lastAssistantText: "posted",
    });
    await vi.waitFor(() =>
      expect(store.getRun("run_live")).toMatchObject({
        status: "reviewing",
        finishedAt: expect.any(Number),
      }),
    );
    // Every thread reads back as gone: a poll pass that took the claimed run for
    // abandoned would fail it while its verification is still reading GitHub.
    harness.sdk.stub("threads.get", () => {
      throw Object.assign(new Error("HTTP 404: Thread not found"), {
        code: "thread_not_found",
        status: 404,
      });
    });
    const service = harness.behavior.runService("watcher");
    await vi.waitFor(() => expect(store.getRun("run_gone")?.status).toBe("failed"));
    expect(store.getRun("run_live")?.status).toBe("reviewing");

    release();
    await vi.waitFor(() =>
      expect(store.getRun("run_live")).toMatchObject({ status: "commented", commentCount: 1 }),
    );
    service.controller.abort();
    await service.done;
  } finally {
    github.gate = Promise.resolve();
    github.issueComments = [];
    await harness.lifecycle.dispose();
  }
});

it("keeps a run an event claimed while a poll pass was still reading its thread", async () => {
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
    // The first read of the live thread hangs until released; every other read
    // says the thread is gone, which would fail a run nobody owns.
    let releaseLookup = () => {};
    let liveLookups = 0;
    harness.sdk.stub("threads.get", ({ threadId }: { threadId: string }) => {
      if (threadId === "thr_live" && ++liveLookups === 1)
        return new Promise<ReturnType<typeof makeThreadResponse>>((resolve) => {
          releaseLookup = () => resolve(makeThreadResponse({ id: threadId }));
        });
      throw Object.assign(new Error("HTTP 404: Thread not found"), {
        code: "thread_not_found",
        status: 404,
      });
    });
    harness.sdk.stub("threads.output", () => ({ output: "posted" }));

    let service = harness.behavior.runService("watcher");
    await vi.waitFor(() => expect(liveLookups).toBe(1));
    // While the pass waits on the thread, its idle event claims the run and
    // starts a verification that GitHub holds.
    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_live" }),
      lastAssistantText: "posted",
    });
    await vi.waitFor(() =>
      expect(store.getRun("run_live")).toMatchObject({
        status: "reviewing",
        finishedAt: expect.any(Number),
      }),
    );
    releaseLookup();
    // The pass reads the thread's output, finds the run claimed, and moves on.
    await vi.waitFor(() => expect(harness.sdk.callsTo("threads.output")).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    service.controller.abort();
    await service.done;

    // The next pass finds the claim still held by that event, not abandoned.
    store.insertRun(makeRun({ id: "run_gone", threadId: "thr_gone" }));
    service = harness.behavior.runService("watcher");
    await vi.waitFor(() => expect(store.getRun("run_gone")?.status).toBe("failed"));
    expect(store.getRun("run_live")?.status).toBe("reviewing");

    release();
    await vi.waitFor(() =>
      expect(store.getRun("run_live")).toMatchObject({ status: "commented", commentCount: 1 }),
    );
    service.controller.abort();
    await service.done;
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

it("reads GitHub once more, 4 s later, before believing a live run posted nothing", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "slopcop",
    settings: { settleFinishedThreads: false },
  });
  try {
    await plugin(bb);
    // Only the timer the retry waits on is faked; the scheduler keeps running.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const store = createStore(bb.storage.database() as never);
    /** Finishes a live run whose first read finds nothing and whose retry finds `retry`. */
    const verify = async (name: string, retry: GhComment[]) => {
      store.insertRun(makeRun({ id: `run_${name}`, threadId: `thr_${name}`, mode: "live" }));
      github.issueComments = [];
      github.issueCommentReads = 0;
      await harness.behavior.emitThreadEvent("thread.idle", {
        thread: makeThreadResponse({ id: `thr_${name}` }),
        lastAssistantText: "posted",
      });
      await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
      await vi.advanceTimersByTimeAsync(3_900);
      expect(github.issueCommentReads).toBe(1);
      expect(store.getRun(`run_${name}`)?.status).toBe("reviewing");
      github.issueComments = retry;
      await vi.advanceTimersByTimeAsync(200);
      await vi.waitFor(() => expect(store.getRun(`run_${name}`)?.status).not.toBe("reviewing"));
      // One retry only: nothing reads GitHub again afterwards.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(github.issueCommentReads).toBe(2);
      return store.getRun(`run_${name}`);
    };

    const ownReview = {
      id: "c1",
      body: review("late"),
      url: null,
      author: "slopcop-bot",
      path: null,
      line: null,
      createdAt: Date.now(),
    };
    expect(await verify("late", [ownReview])).toMatchObject({
      status: "commented",
      commentCount: 1,
    });
    expect(await verify("silent", [])).toMatchObject({
      status: "no_comment",
      detail: "the thread finished without posting anything to the PR",
    });
  } finally {
    vi.useRealTimers();
    github.issueComments = [];
    await harness.lifecycle.dispose();
  }
});
