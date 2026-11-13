import { describe, expect, it } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ChangesView } from "../core/project";
import { fitChanges, snapshotKey } from "./snapshots";
import { createProjectSource, diffQuery, problemFailure, prStatusInfo, prStatusSettling, pullRequestInfo } from "./source";
import type { PrStatus } from "./checkout";

type Fake = Record<string, Record<string, (args: never) => unknown>>;

/**
 * `bb.sdk.plugins.callRpc` for Source Control and the PR status plugin, answering from
 * `reads` and parsing each answer with the caller's schema as bb does.
 */
function pluginReads(reads: Record<string, (input: never) => unknown>) {
  return {
    callRpc: async ({ pluginId, method, input, outputSchema }: { pluginId: string; method: string; input: never; outputSchema: { parse(value: unknown): unknown } }) => {
      const read = reads[`${pluginId}.${method}`];
      if (read === undefined) throw new Error(`no fake for ${pluginId}.${method}`);
      return outputSchema.parse(await read(input));
    },
  };
}

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
    { path: "src/a.ts", previousPath: null, kind: "modified", additions: 3, deletions: 1, binary: false, untracked: false },
    { path: "src/b.ts", previousPath: "old/b.ts", kind: "renamed", additions: 0, deletions: 0, binary: false, untracked: false },
    { path: "logo.png", previousPath: null, kind: "added", additions: 0, deletions: 0, binary: true, untracked: true },
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
    },
    plugins: pluginReads({
      "source-control.checkoutStatus": (args: unknown) => {
        calls.push({ method: "checkoutStatus", args });
        return {
          ok: true,
          value: {
            state: "read",
            head: { kind: "branch", name: "feat", sha: "f".repeat(40) },
            defaultBranch: "main",
            base: "main",
            uncommitted: { files: 0, additions: 0, deletions: 0 },
            mergeBase: { ahead: 1, behind: 2, commits: [{ sha: "abc1234def", subject: "Fix", author: "Ana", authoredAt: 5 }] },
          },
        };
      },
      "source-control.checkoutFiles": (args: unknown) => {
        calls.push({ method: "files", args });
        // Each read sees a newer state, so a kept snapshot is told apart from a fresh read.
        now += 1;
        return {
          ok: true,
          value: {
            files: files.map((file) => ({ ...file, additions: file.additions * now })),
            patches: [{ path: "src/a.ts", kind: "modified", previousPath: null, patch: "@@ -1 +1 @@\n-a\n+b", truncated: false }],
            truncated: false,
          },
        };
      },
      "source-control.checkoutPatches": (args: { files: { path: string }[] }) => {
        calls.push({ method: "patches", args });
        return { ok: true, value: { patches: args.files.map(({ path }) => ({ path, patch: `@@ ${path}`, truncated: false })) } };
      },
      "bb--github-pr-status.pullRequests": ({ keys }: { keys: string[] }) => ({ [keys[0]!]: { outcome: "absent" } }),
    }),
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
    expect(calls.find((call) => call.method === "files")?.args).toMatchObject({ target: { kind: "branch", base: "main" } });
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
    expect(calls.filter((call) => call.method === "files")).toHaveLength(1);
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
    expect(problemFailure({ kind: "host-offline", host: "laptop" })).toEqual({ ok: false, reason: "unavailable", message: "laptop is offline" });
    expect(problemFailure({ kind: "moved", detail: "This thread's environment is creating." })).toMatchObject({ reason: "no-environment" });
    expect(problemFailure({ kind: "failed", detail: "git failed." })).toEqual({ ok: false, reason: "unavailable", message: "git failed." });
  });

  it("refuses patch paths that leave the repository", async () => {
    const { source, calls } = fakeBb();
    for (const path of ["/etc/passwd", "src/../../x", ""]) {
      expect(await source.patches("thr_mine00", { kind: "branch" }, [path])).toMatchObject({ ok: false, reason: "invalid" });
    }
    expect(calls.some((call) => call.method === "patches")).toBe(false);
  });
});

describe("diff queries", () => {
  it("asks only for uncommitted work on the default branch itself and on an unborn branch", () => {
    expect(diffQuery({ kind: "branch" }, { kind: "branch", name: "main", sha: "f".repeat(40) }, "main", [])).toMatchObject({
      query: { kind: "uncommitted" },
      scope: { onBase: true },
    });
    expect(diffQuery({ kind: "branch" }, { kind: "unborn", name: "main" }, "main", [])).toMatchObject({
      query: { kind: "uncommitted" },
      scope: { kind: "uncommitted", unborn: true },
    });
    expect(diffQuery({ kind: "branch" }, { kind: "detached", sha: "abcdef1234" }, "main", [])).toMatchObject({
      query: { kind: "branch", base: "main" },
      scope: { kind: "branch", branch: null, head: "abcdef1" },
    });
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

/** A pull request as Source Control reads it by reference; open, clean, approved and passing unless overridden. */
function prStatus(number: number, overrides: Partial<PrStatus> = {}): PrStatus {
  return {
    number,
    url: `https://github.com/Argus-Labs/rampage-client/pull/${number}`,
    title: `Rampage change ${number}`,
    state: "open",
    isDraft: false,
    baseRef: "main",
    headRef: `feat/${number}`,
    updatedAt: "2026-11-10T12:00:00Z",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    reviewRequests: 0,
    checks: { passed: 5, failed: 0, pending: 0 },
    autoMerge: false,
    inMergeQueue: false,
    ...overrides,
  };
}

describe("PullRequest refs", () => {
  const RAMPAGE = "Argus-Labs/rampage-client";
  const ref = (number: number) => ({ owner: "Argus-Labs", repo: "rampage-client", number });

  function byRef(answer: (input: { environmentId: string | null; refs: { owner: string; repo: string; number: number }[] }) => unknown) {
    const asked: { environmentId: string | null; refs: string[] }[] = [];
    const bb = fakeBb({
      plugins: pluginReads({
        "source-control.pullRequestsByRef": (input: { environmentId: string | null; refs: { owner: string; repo: string; number: number }[] }) => {
          asked.push({ environmentId: input.environmentId, refs: input.refs.map((each) => `${each.owner}/${each.repo}#${each.number}`) });
          return answer(input);
        },
      }),
    } as never);
    return { ...bb, asked };
  }

  it("reads the named pull requests through the thread's environment, each row on its own", async () => {
    const { source, asked } = byRef(() => ({
      [`${RAMPAGE}#2419`]: { ok: true, value: prStatus(2419, { state: "merged" }) },
      [`${RAMPAGE}#2423`]: { ok: true, value: prStatus(2423, { isDraft: true, mergeStateStatus: "DRAFT", reviewDecision: null }) },
      [`${RAMPAGE}#9999`]: { ok: false, reason: "not-found", message: `${RAMPAGE}#9999 is not a pull request GitHub knows.` },
    }));
    const view = await source.pullRequests("thr_mine00", [ref(2419), ref(2423), ref(9999)], false);
    expect(asked).toEqual([{ environmentId: "env_a", refs: [`${RAMPAGE}#2419`, `${RAMPAGE}#2423`, `${RAMPAGE}#9999`] }]);
    expect(view.ok && view.rows.map(({ ref, read }) => [ref.number, read.ok ? read.pullRequest.state : read.reason])).toEqual([
      [2419, "merged"],
      [2423, "draft"],
      [9999, "not-found"],
    ]);
  });

  it("leaves each row unavailable, not the reply, when Source Control can't be asked", async () => {
    const { source } = fakeBb();
    const view = await source.pullRequests("thr_mine00", [ref(2419), ref(2420)], false);
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect(view.rows.map(({ read }) => !read.ok && read.reason)).toEqual(["unavailable", "unavailable"]);
    expect(!view.rows[0]!.read.ok && view.rows[0]!.read.message).toMatch(/^Source Control couldn't read pull requests/);
  });

  it("shares one read between blocks naming the same pull requests, and reads again on Refresh", async () => {
    const { source, asked } = byRef(({ refs }) =>
      Object.fromEntries(refs.map((each) => [`${each.owner}/${each.repo}#${each.number}`, { ok: true, value: prStatus(each.number) }])),
    );
    await Promise.all([source.pullRequests("thr_mine00", [ref(2420)], false), source.pullRequests("thr_mine00", [ref(2420)], false)]);
    await source.pullRequests("thr_mine00", [ref(2420)], false);
    expect(asked).toHaveLength(1);
    await source.pullRequests("thr_mine00", [ref(2420)], true);
    expect(asked).toHaveLength(2);
  });

  it("refuses a thread BB doesn't have", async () => {
    const { source, asked } = byRef(() => ({}));
    expect(await source.pullRequests("thr_nobody", [ref(1)], false)).toMatchObject({ ok: false, reason: "not-found" });
    expect(asked).toHaveLength(0);
  });

  // The same pull request reaches a card through bb's PR status plugin (this branch's) and through
  // Source Control (by reference). Rows give the facts once; `branch` is what bb's plugin reports
  // for them (its assemble rules). The by-reference reading may say less ("unknown", no attention)
  // but never something else.
  const SAME_FACTS: { name: string; facts: Partial<PrStatus>; branch: { state: string; checks: string; review: string; mergeability: string; attention: string } }[] = [
    { name: "clean and approved", facts: {}, branch: { state: "open", checks: "passing", review: "approved", mergeability: "mergeable", attention: "ready_to_merge" } },
    { name: "conflicting", facts: { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }, branch: { state: "open", checks: "passing", review: "approved", mergeability: "conflicts", attention: "conflicts" } },
    { name: "blocked by rules", facts: { mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED" }, branch: { state: "open", checks: "passing", review: "review_required", mergeability: "blocked", attention: "review_requested" } },
    { name: "blocked, approved", facts: { mergeStateStatus: "BLOCKED" }, branch: { state: "open", checks: "passing", review: "approved", mergeability: "blocked", attention: "blocked" } },
    { name: "behind its base", facts: { mergeStateStatus: "BEHIND" }, branch: { state: "open", checks: "passing", review: "approved", mergeability: "blocked", attention: "blocked" } },
    { name: "pre-receive hooks", facts: { mergeStateStatus: "HAS_HOOKS" }, branch: { state: "open", checks: "passing", review: "approved", mergeability: "blocked", attention: "blocked" } },
    { name: "failing checks", facts: { mergeStateStatus: "UNSTABLE", checks: { passed: 3, failed: 2, pending: 0 } }, branch: { state: "open", checks: "failing", review: "approved", mergeability: "mergeable", attention: "checks_failed" } },
    { name: "still computing", facts: { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN", checks: { passed: 1, failed: 0, pending: 2 } }, branch: { state: "open", checks: "pending", review: "approved", mergeability: "unknown", attention: "checks_pending" } },
    { name: "draft", facts: { isDraft: true, mergeStateStatus: "DRAFT", reviewDecision: null, reviewRequests: 1 }, branch: { state: "draft", checks: "passing", review: "review_requested", mergeability: "draft", attention: "draft" } },
    { name: "queued", facts: { inMergeQueue: true }, branch: { state: "open", checks: "passing", review: "approved", mergeability: "mergeable", attention: "queued" } },
    { name: "merged", facts: { state: "merged" }, branch: { state: "merged", checks: "passing", review: "approved", mergeability: "mergeable", attention: "merged" } },
    { name: "no checks", facts: { checks: { passed: 0, failed: 0, pending: 0 }, reviewDecision: null }, branch: { state: "open", checks: "no_checks", review: "none", mergeability: "mergeable", attention: "none" } },
  ];

  it.each(SAME_FACTS)("reads $name the same through either source", ({ facts, branch }) => {
    const status = prStatus(2420, facts);
    const fromBranch = pullRequestInfo({
      number: status.number,
      title: status.title,
      url: status.url,
      state: branch.state as never,
      baseRefName: status.baseRef,
      headRefName: status.headRef,
      checks: { state: branch.checks as never, passedCount: status.checks.passed, failedCount: status.checks.failed, pendingCount: status.checks.pending, totalCount: 5 },
      review: { state: branch.review as never, reviewRequestCount: status.reviewRequests },
      mergeability: { state: branch.mergeability as never },
      attention: branch.attention as never,
      autoMerge: status.autoMerge,
      inMergeQueue: status.inMergeQueue,
      updatedAt: status.updatedAt!,
    });
    const fromRef = prStatusInfo(status);
    expect([fromRef.state, fromRef.checks.state, fromRef.review.state]).toEqual([fromBranch.state, fromBranch.checks.state, fromBranch.review.state]);
    expect([fromBranch.mergeability, "unknown"]).toContain(fromRef.mergeability);
    expect([fromBranch.attention, "none"]).toContain(fromRef.attention);
  });

  it("claims no Blocked or Ready to merge from a merge state that names neither", () => {
    for (const mergeStateStatus of ["BEHIND", "HAS_HOOKS", "UNKNOWN", null]) {
      const info = prStatusInfo(prStatus(1, { mergeStateStatus }));
      expect(info.mergeability).toBe("unknown");
      expect(info.attention).toBe("none");
    }
    expect(prStatusInfo(prStatus(1)).attention).toBe("ready_to_merge");
  });
});

describe("PullRequest refs: when to read again", () => {
  it("keeps reading while GitHub computes, and stops for a merge state that won't change on its own", () => {
    expect(prStatusSettling(prStatus(1, { mergeStateStatus: "BEHIND" }))).toBe(false);
    expect(prStatusSettling(prStatus(1, { mergeStateStatus: "HAS_HOOKS" }))).toBe(false);
    expect(prStatusSettling(prStatus(1))).toBe(false);
    expect(prStatusSettling(prStatus(1, { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }))).toBe(true);
    expect(prStatusSettling(prStatus(1, { checks: { passed: 2, failed: 0, pending: 1 } }))).toBe(true);
    expect(prStatusSettling(prStatus(1, { inMergeQueue: true }))).toBe(true);
    expect(prStatusSettling(prStatus(1, { state: "merged", mergeStateStatus: "UNKNOWN" }))).toBe(false);
  });

  it("marks each row read through Source Control with whether it is settling", async () => {
    const bb = fakeBb({
      plugins: pluginReads({
        "source-control.pullRequestsByRef": () => ({
          "o/r#1": { ok: true, value: prStatus(1, { mergeStateStatus: "BEHIND" }) },
          "o/r#2": { ok: true, value: prStatus(2, { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }) },
        }),
      }),
    } as never);
    const view = await bb.source.pullRequests("thr_mine00", [{ owner: "o", repo: "r", number: 1 }, { owner: "o", repo: "r", number: 2 }], false);
    expect(view.ok && view.rows.map(({ read }) => read.ok && read.settling)).toEqual([false, true]);
  });
});
