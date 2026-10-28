import { describe, expect, it } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ChangesView } from "../core/project";
import { fitChanges, snapshotKey } from "./snapshots";
import { createProjectSource, diffQuery, outcomeFailure } from "./source";

type Fake = Record<string, Record<string, (args: never) => unknown>>;

/** A BB with one project's threads and one checkout; only what source.ts calls. */
function fakeBb(overrides: Fake = {}) {
  const calls: { method: string; args: unknown }[] = [];
  const kv = new Map<string, unknown>();
  const threads: Record<string, object> = {
    thr_mine00: { id: "thr_mine00", projectId: "proj_a", environmentId: "env_a", deletedAt: null, parentThreadId: null },
    thr_child0: { ...thread("thr_child0", "proj_a", "active", "thr_mine00"), hasPendingInteraction: true },
    thr_other0: thread("thr_other0", "proj_b", "idle"),
    // An idle orchestrator whose two workers (one a hidden workflow step) still run.
    thr_idle00: thread("thr_idle00", "proj_a", "idle"),
    thr_work01: thread("thr_work01", "proj_a", "active", "thr_idle00"),
    thr_work02: { ...thread("thr_work02", "proj_a", "active", "thr_idle00"), visibility: "hidden" },
    // BB fails every read of its message and interactions.
    thr_broken: thread("thr_broken", "proj_a", "idle"),
  };
  const outputs: Record<string, string | null> = {
    thr_child0: "Built `Orbit.app` on **feat/399**.\n\nWaiting for the install receipt.",
    thr_other0: "Another project's secret",
    thr_idle00: null,
  };
  const interactions: Record<string, object[]> = {
    thr_child0: [
      {
        id: "pi_1",
        createdAt: 40,
        payload: {
          kind: "user_question",
          questions: [{ id: "q", prompt: "Install feat/399 or main?", allowFreeText: true, multiSelect: false, options: [{ label: "feat/399", value: "a" }, { label: "main", value: "b" }] }],
        },
        status: "pending",
        threadId: "thr_child0",
        turnId: "turn_1",
      },
    ],
    thr_other0: [{ id: "pi_2", createdAt: 1, payload: { kind: "plugin", title: "Secret" }, status: "pending" }],
  };
  let now = 1;
  const files = [
    { path: "src/a.ts", previousPath: null, changeKind: "modified", additions: 3, deletions: 1, binary: false, loadMode: "auto", origin: "tracked" },
    { path: "src/b.ts", previousPath: "old/b.ts", changeKind: "renamed", additions: 0, deletions: 0, binary: false, loadMode: "on_demand", origin: "tracked" },
    { path: "logo.png", previousPath: null, changeKind: "added", additions: 0, deletions: 0, binary: true, loadMode: "auto", origin: "untracked" },
  ];
  const sdk = {
    threads: {
      get: async ({ threadId }: { threadId: string }) => {
        calls.push({ method: "threads.get", args: threadId });
        if (!(threadId in threads)) throw new Error("404");
        return threads[threadId];
      },
      list: async (args: unknown) => {
        calls.push({ method: "threads.list", args });
        return [threads.thr_child0];
      },
      listRunning: async () => {
        calls.push({ method: "threads.listRunning", args: null });
        return ["thr_child0", "thr_work01", "thr_work02"].map((id) => ({ id, hostId: null }));
      },
      output: async ({ threadId }: { threadId: string }) => {
        calls.push({ method: "threads.output", args: threadId });
        if (threadId === "thr_broken") throw new Error("500");
        return { output: outputs[threadId] ?? null };
      },
      interactions: {
        list: async ({ threadId }: { threadId: string }) => {
          calls.push({ method: "interactions.list", args: threadId });
          if (threadId === "thr_broken") throw new Error("500");
          return interactions[threadId] ?? [];
        },
      },
      defaultExecutionOptions: async () => ({ model: "opus", reasoningLevel: "high" }),
      // The running child's latest event is newer than its updatedAt (10).
      events: { list: async () => [{ createdAt: 50 }] },
    },
    providers: { list: async () => [{ id: "claude-code", displayName: "Claude Code", logoUrl: null }] },
    environments: {
      get: async () => ({ isGitRepo: true, mergeBaseBranch: null, defaultBranch: "main", branchName: "feat" }),
      status: async (args: unknown) => {
        calls.push({ method: "status", args });
        return {
          outcome: "available",
          workspace: {
            branch: { currentBranch: "feat", defaultBranch: "main" },
            checkout: { kind: "branch", branchName: "feat", headSha: "f".repeat(40) },
            mergeBase: { aheadCount: 1, behindCount: 2, commits: [{ sha: "abc1234def", shortSha: "abc1234", subject: "Fix", authorName: "Ana", authoredAt: 5 }] },
          },
        };
      },
      diffFiles: async (args: unknown) => {
        calls.push({ method: "diffFiles", args });
        // Each read sees a newer state, so a kept snapshot is told apart from a fresh read.
        now += 1;
        return {
          outcome: "available",
          files: files.map((file) => ({ ...file, additions: file.additions * now })),
          initialPatches: [{ path: "src/a.ts", patch: "@@ -1 +1 @@\n-a\n+b", truncated: false }],
          truncated: false,
          mergeBaseRef: "m",
          shortstat: "",
        };
      },
      diffPatch: async (args: { paths: string[] }) => {
        calls.push({ method: "diffPatch", args });
        return { outcome: "available", patches: args.paths.map((path) => ({ path, patch: `@@ ${path}`, truncated: false })) };
      },
      pullRequest: async () => ({ outcome: "absent" }),
    },
    ...overrides,
  };
  const storage = {
    get: async (key: string) => kv.get(key) as never,
    set: async (key: string, value: unknown) => void kv.set(key, structuredClone(value)),
  };
  const source = createProjectSource({ sdk } as unknown as BbPluginApi, storage);
  return { source, calls, kv };
}

function thread(id: string, projectId: string, status: string, parentThreadId: string | null = null) {
  return {
    id,
    projectId,
    parentThreadId,
    title: null,
    titleFallback: "First message",
    runtime: { displayStatus: status },
    archivedAt: null,
    deletedAt: null,
    providerId: "claude-code",
    updatedAt: 10,
  };
}

describe("Changes", () => {
  it("compares the branch with the default branch, all changes included", async () => {
    const { source, calls } = fakeBb();
    const view = await source.changes("thr_mine00", { kind: "branch" }, null, null);
    expect(calls.find((call) => call.method === "diffFiles")?.args).toMatchObject({ target: "all", mergeBaseBranch: "main" });
    expect(view).toMatchObject({ ok: true, scope: { kind: "branch", branch: "feat", base: "main", onBase: false }, stored: false });
    if (!view.ok) return;
    expect(view.files.map((file) => [file.path, file.diff])).toEqual([
      ["src/a.ts", "inline"],
      ["src/b.ts", "on-demand"],
      ["logo.png", "binary"],
    ]);
  });

  it("keeps a renamed file when the filter names where it came from", async () => {
    const { source } = fakeBb();
    const view = await source.changes("thr_mine00", { kind: "branch" }, ["old"], null);
    expect(view.ok && view.files.map((file) => file.path)).toEqual(["src/b.ts"]);
  });

  it("shows a kept snapshot until refreshed, with the on-demand patches kept beside the inline ones", async () => {
    const { source, calls } = fakeBb();
    const keep = { blockKey: "bb.genui.state:msg#ui#0", refresh: false };
    const first = await source.changes("thr_mine00", { kind: "uncommitted" }, null, keep);
    const again = await source.changes("thr_mine00", { kind: "uncommitted" }, null, keep);
    expect(again).toEqual(first);
    expect(first.ok && first.patches.map((patch) => patch.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(first.ok && first.livePatches).toBe(false);
    expect(calls.filter((call) => call.method === "diffFiles")).toHaveLength(1);
    const refreshed = await source.changes("thr_mine00", { kind: "uncommitted" }, null, { ...keep, refresh: true });
    expect(refreshed.ok && refreshed.files[0]!.additions).not.toBe(first.ok && first.files[0]!.additions);
    // The refresh replaced what later renders show.
    expect(await source.changes("thr_mine00", { kind: "uncommitted" }, null, keep)).toEqual(refreshed);
  });

  it("never keeps a commit's changes: a commit cannot change", async () => {
    const { source, kv } = fakeBb();
    const view = await source.changes("thr_mine00", { kind: "commit", sha: "abc1234" }, null, { blockKey: "b", refresh: false });
    expect(view).toMatchObject({ ok: true, stored: false, scope: { kind: "commit", sha: "abc1234def", subject: "Fix" } });
    expect(kv.size).toBe(0);
  });

  it("says why there is nothing to show", async () => {
    expect(await fakeBb().source.changes("thr_nobody", { kind: "branch" }, null, null)).toMatchObject({ ok: false, reason: "not-found" });
    expect(await fakeBb().source.changes("../etc", { kind: "branch" }, null, null)).toMatchObject({ ok: false, reason: "invalid" });
    expect(outcomeFailure({ outcome: "not_applicable", message: "x" })).toMatchObject({ reason: "not-git" });
    expect(
      outcomeFailure({ outcome: "unavailable", failure: { code: "path_not_found", message: "Workspace path does not exist" } }),
    ).toEqual({ ok: false, reason: "unavailable", message: "Workspace path does not exist" });
  });

  it("refuses patch paths that leave the repository", async () => {
    const { source, calls } = fakeBb();
    for (const path of ["/etc/passwd", "src/../../x", ""]) {
      expect(await source.patches("thr_mine00", { kind: "branch" }, [path])).toMatchObject({ ok: false, reason: "invalid" });
    }
    expect(calls.some((call) => call.method === "diffPatch")).toBe(false);
  });
});

describe("diff queries", () => {
  it("asks only for uncommitted work on the default branch itself and on an unborn branch", () => {
    expect(diffQuery({ kind: "branch" }, { kind: "branch", branchName: "main", headSha: null }, "main", [])).toMatchObject({
      query: { target: "uncommitted" },
      scope: { onBase: true },
    });
    expect(diffQuery({ kind: "branch" }, { kind: "unborn", branchName: "main" }, "main", [])).toMatchObject({
      query: { target: "uncommitted" },
      scope: { kind: "uncommitted", unborn: true },
    });
    expect(diffQuery({ kind: "branch" }, { kind: "unknown", reason: "rebase in progress" }, "main", [])).toMatchObject({ ok: false });
  });
});

describe("Threads", () => {
  it("lists the thread's subthreads with provider and model", async () => {
    const { source, calls } = fakeBb();
    const view = await source.threads("thr_mine00", null);
    expect(calls.find((call) => call.method === "threads.list")?.args).toMatchObject({ parentThreadId: "thr_mine00" });
    expect(view).toMatchObject({
      ok: true,
      mode: "subthreads",
      threads: [
        { found: true, id: "thr_child0", title: "First message", status: "active", model: "opus", provider: { name: "Claude Code" }, updatedAt: 50 },
      ],
    });
  });

  it("answers not found for another project's thread, unknown ids and malformed ids alike", async () => {
    const view = await fakeBb().source.threads("thr_mine00", ["thr_child0", "thr_other0", "thr_nobody", "<script>"]);
    expect(view.ok && view.threads.map((thread) => thread.found)).toEqual([true, false, false, false]);
  });

  it("shows a subthread's latest message, the question it waits on, and its reasoning level", async () => {
    const view = await fakeBb().source.threads("thr_mine00", null);
    expect(view.ok && view.threads[0]).toMatchObject({
      id: "thr_child0",
      needsInput: true,
      model: "opus",
      reasoning: "high",
      lastMessage: { text: "Built `Orbit.app` on **feat/399**.\n\nWaiting for the install receipt.", truncated: false },
      pending: { kind: "question", action: "Answer a question", text: "Install feat/399 or main?", options: ["feat/399", "main"], more: 0, since: 40 },
      runningWorkers: 0,
    });
  });

  it("counts an idle parent's running workers, hidden ones included", async () => {
    const view = await fakeBb().source.threads("thr_mine00", ["thr_idle00", "thr_work01"]);
    expect(view.ok && view.threads).toMatchObject([
      { id: "thr_idle00", status: "idle", needsInput: false, pending: null, lastMessage: null, runningWorkers: 2 },
      { id: "thr_work01", status: "active", runningWorkers: 0 },
    ]);
  });

  it("reads a message again only once the thread has acted, and a running thread's parent once", async () => {
    const { source, calls } = fakeBb();
    await source.threads("thr_mine00", ["thr_idle00", "thr_child0"]);
    await source.threads("thr_mine00", ["thr_idle00", "thr_child0"]);
    const count = (method: string, args: string) => calls.filter((call) => call.method === method && call.args === args).length;
    expect(count("threads.output", "thr_idle00")).toBe(1);
    expect(count("threads.output", "thr_child0")).toBe(1);
    expect(count("threads.get", "thr_work01")).toBe(1);
    // Interactions are live: read on every poll.
    expect(count("interactions.list", "thr_child0")).toBe(2);
  });

  it("never reads another project's thread's message or interactions", async () => {
    const { source, calls } = fakeBb();
    const view = await source.threads("thr_mine00", ["thr_other0"]);
    expect(view.ok && view.threads).toEqual([{ found: false, id: "thr_other0" }]);
    expect(calls.filter((call) => call.args === "thr_other0").map((call) => call.method)).toEqual(["threads.get"]);
  });

  it("shows what it has when BB can't read a thread's message or interactions", async () => {
    const view = await fakeBb().source.threads("thr_mine00", ["thr_broken"]);
    expect(view.ok && view.threads[0]).toMatchObject({ found: true, needsInput: false, pending: null, lastMessage: null });
  });
});

describe("snapshot size", () => {
  const view: ChangesView = {
    ok: true,
    scope: { kind: "uncommitted", branch: "main", unborn: false },
    files: Array.from({ length: 20 }, (_, index) => ({
      path: `f${index}.ts`,
      previousPath: null,
      kind: "modified" as const,
      additions: 1,
      deletions: 1,
      untracked: false,
      diff: "on-demand" as const,
    })),
    totalFiles: 20,
    filter: null,
    listTruncated: false,
    patches: [],
    livePatches: true,
    takenAt: 0,
    stored: false,
  };

  it("keeps whole patches in file order while they fit, skipping one too large to keep", () => {
    const patches = view.files.map((file, index) => ({ path: file.path, patch: "x".repeat(index === 1 ? 200_000 : 1_000), truncated: false }));
    const fitted = fitChanges(view, patches, 6_000);
    expect(fitted.files).toHaveLength(20);
    // f1 is too large to keep at all; f4 would no longer fit.
    expect(fitted.patches.map((patch) => patch.path)).toEqual(["f0.ts", "f2.ts", "f3.ts"]);
    expect(Buffer.byteLength(JSON.stringify(fitted))).toBeLessThanOrEqual(6_000);
    expect(fitted).toMatchObject({ stored: true, livePatches: false, listTruncated: false });
  });

  it("cuts the file list itself, marked truncated, when even the rows don't fit", () => {
    const fitted = fitChanges(view, [], 1_200);
    expect(fitted.files.length).toBeLessThan(20);
    expect(fitted.listTruncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(fitted))).toBeLessThanOrEqual(1_200);
  });

  it("keys a block's request apart from every other request and block", () => {
    const changes = { kind: "changes", target: { kind: "branch" }, paths: null } as const;
    expect(snapshotKey("thr_a0000", "block", changes)).not.toBe(snapshotKey("thr_a0000", "block", { ...changes, target: { kind: "uncommitted" } }));
    expect(snapshotKey("thr_a0000", "block", changes)).not.toBe(snapshotKey("thr_a0000", "block2", changes));
    expect(snapshotKey("thr_a0000", "block", changes).startsWith("snapshot:thr_a0000:")).toBe(true);
  });
});
