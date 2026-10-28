import { describe, expect, it } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { EnvironmentDetail } from "../core/environments";
import {
  checkoutFailure,
  checkoutStatus,
  createEnvironmentsSource,
  environmentKind,
  environmentLife,
  mapLimit,
  type EnvironmentEntry,
  type ThreadEntry,
  type WorkspaceEntry,
} from "./environments";

/** BB's environment record as `bb environment list --json` prints it, trimmed to what Environments reads. */
function environment(id: string, overrides: Partial<EnvironmentEntry> = {}): EnvironmentEntry {
  return {
    id,
    name: null,
    projectId: "proj_a",
    path: `/work/${id}`,
    isGitRepo: true,
    isWorktree: true,
    branchName: `wt/${id}`,
    defaultBranch: "main",
    mergeBaseBranch: null,
    status: "ready",
    environmentProviderId: "project-checkout",
    lifecycle: { phase: "active" },
    hostLifecycle: "active",
    workspaceProvisionType: "unmanaged",
    updatedAt: 100,
    ...overrides,
  };
}

function thread(id: string, environmentId: string | null, overrides: Partial<ThreadEntry> = {}): ThreadEntry {
  return {
    id,
    projectId: "proj_a",
    environmentId,
    environmentName: null,
    environmentPath: null,
    environmentBranchName: null,
    environmentIsWorktree: null,
    environmentProviderId: null,
    title: `Thread ${id}`,
    titleFallback: null,
    runtime: { displayStatus: "idle" },
    hasPendingInteraction: false,
    archivedAt: null,
    deletedAt: null,
    parentThreadId: null,
    latestAttentionAt: 10,
    createdAt: 1,
    updatedAt: 500,
    ...overrides,
  };
}

/** environments.status for a clean branch 2 ahead and 1 behind its base, with uncommitted work. */
function workspace(branch: string, overrides: Partial<WorkspaceEntry> = {}): WorkspaceEntry {
  return {
    branch: { defaultBranch: "main" },
    checkout: { kind: "branch", branchName: branch, headSha: "82af8f087df1cb963097461359446d9a69b36dc9" },
    mergeBase: { aheadCount: 2, behindCount: 1 },
    workingTree: { files: [{}, {}], insertions: 12, deletions: 3, lineStatsComplete: true },
    ...overrides,
  };
}

const PULL_REQUEST = {
  number: 424,
  title: "Offline search index",
  url: "https://github.com/acme/app/pull/424",
  state: "draft",
  baseRefName: "main",
  headRefName: "wt/env_wt01",
  checks: { state: "failing", passedCount: 3, failedCount: 1, pendingCount: 0, totalCount: 4 },
  review: { state: "none", reviewRequestCount: 0 },
  mergeability: { state: "draft", mergeable: "MERGEABLE", mergeStateStatus: "DRAFT" },
  attention: "draft",
  autoMerge: false,
  inMergeQueue: false,
  updatedAt: "2026-10-09T12:00:00Z",
};

/** A BB with two projects: proj_a (the reply's) and proj_b (someone else's). */
function fakeBb(options: { status?: (environmentId: string, base: string | undefined) => unknown } = {}) {
  const calls: { method: string; args: unknown }[] = [];
  const environments: Record<string, EnvironmentEntry> = {
    env_main: environment("env_main", { isWorktree: false, branchName: "main", path: "/work/app" }),
    env_wt01: environment("env_wt01"),
    env_wt02: environment("env_wt02", { updatedAt: 300 }),
    env_gone: environment("env_gone", { status: "destroyed", lifecycle: { phase: "destroyed" }, isGitRepo: false, isWorktree: false, path: null }),
    env_other: environment("env_other", { projectId: "proj_b" }),
  };
  const threads: ThreadEntry[] = [
    thread("thr_mine00", "env_main", { runtime: { displayStatus: "active" }, latestAttentionAt: 50 }),
    thread("thr_main01", "env_main", { latestAttentionAt: 70 }),
    thread("thr_main02", "env_main", { archivedAt: 5, latestAttentionAt: 90 }),
    thread("thr_wt0100", "env_wt01", { hasPendingInteraction: true, latestAttentionAt: 40, title: null, titleFallback: "  Fix the build  " }),
    thread("thr_wt0101", "env_wt01", { parentThreadId: "thr_wt0100", latestAttentionAt: 30 }),
    thread("thr_gone00", "env_gone", { latestAttentionAt: 20 }),
    // BB lists it but it is deleted; and one of another project that a broken filter would leak.
    thread("thr_dead00", "env_wt02", { deletedAt: 9, latestAttentionAt: 999 }),
    thread("thr_other0", "env_other", { projectId: "proj_b" }),
  ];
  const sdk = {
    threads: {
      get: async ({ threadId }: { threadId: string }) => {
        calls.push({ method: "threads.get", args: threadId });
        const found = threads.find((candidate) => candidate.id === threadId);
        if (found === undefined) throw new Error("404");
        return found;
      },
      list: async (args: unknown) => {
        calls.push({ method: "threads.list", args });
        return threads;
      },
      // The running thread's latest event is newer than its latestAttentionAt.
      events: { list: async () => [{ createdAt: 80 }] },
    },
    environments: {
      list: async (args: unknown) => {
        calls.push({ method: "environments.list", args });
        // BB leaves destroyed environments out of the default list, and a broken projectId filter would leak proj_b's.
        return Object.values(environments).filter((entry) => entry.status !== "destroyed");
      },
      get: async ({ environmentId }: { environmentId: string }) => {
        calls.push({ method: "environments.get", args: environmentId });
        const found = environments[environmentId];
        if (found === undefined) throw new Error("404");
        return found;
      },
      status: async (args: { environmentId: string; mergeBaseBranch?: string }) => {
        calls.push({ method: "environments.status", args });
        const custom = options.status?.(args.environmentId, args.mergeBaseBranch);
        if (custom !== undefined) return custom;
        const branch = environments[args.environmentId]?.branchName ?? "main";
        return { outcome: "available", workspace: workspace(branch) };
      },
      pullRequest: async (args: { environmentId: string }) => {
        calls.push({ method: "environments.pullRequest", args });
        return { outcome: "available", pullRequest: PULL_REQUEST };
      },
    },
  };
  return { source: createEnvironmentsSource(sdk as unknown as BbPluginApi["sdk"]), calls };
}

describe("environments: the list", () => {
  it("lists the thread's project's environments with their threads, other projects and deleted threads left out", async () => {
    const { source, calls } = fakeBb();
    const answer = await source.environments("thr_mine00", false);
    if (!answer.ok) throw new Error(answer.message);
    expect(calls.filter((call) => call.method.endsWith(".list"))).toEqual([
      { method: "environments.list", args: { projectId: "proj_a" } },
      { method: "threads.list", args: { projectId: "proj_a", limit: 1001 } },
    ]);
    expect(answer.environments.map((entry) => entry.id)).toEqual(["env_main", "env_wt01", "env_gone", "env_wt02"]);
    expect(answer.environments.every((entry) => entry.detail === null)).toBe(true);
    expect(answer.threadsTruncated).toBe(false);
  });

  it("puts the running thread first, archived ones last, and counts them", async () => {
    const { source } = fakeBb();
    const answer = await source.environments("thr_mine00", false);
    if (!answer.ok) throw new Error(answer.message);
    const main = answer.environments[0]!;
    expect(main).toMatchObject({ kind: "checkout", branch: "main", base: "main", current: true, life: "ready" });
    expect(main.threads.map((entry) => [entry.id, entry.status, entry.archived, entry.activeAt])).toEqual([
      ["thr_mine00", "active", false, 80],
      ["thr_main01", "idle", false, 70],
      ["thr_main02", "idle", true, 90],
    ]);
    expect(main.threadCounts).toEqual({ total: 3, live: 2, running: 1, needsInput: 0 });
    expect(main.activeAt).toBe(90);
  });

  it("maps titles, subthreads and waiting threads", async () => {
    const { source } = fakeBb();
    const answer = await source.environments("thr_mine00", false);
    if (!answer.ok) throw new Error(answer.message);
    const worktree = answer.environments.find((entry) => entry.id === "env_wt01")!;
    expect(worktree.kind).toBe("worktree");
    expect(worktree.current).toBe(false);
    expect(worktree.threads.map((entry) => [entry.title, entry.needsInput, entry.subthread])).toEqual([
      ["Fix the build", true, false],
      ["Thread thr_wt0101", false, true],
    ]);
    expect(worktree.threadCounts.needsInput).toBe(1);
  });

  it("keeps a destroyed environment a live thread still points at, and an environment without threads has no activity", async () => {
    const { source } = fakeBb();
    const answer = await source.environments("thr_mine00", false);
    if (!answer.ok) throw new Error(answer.message);
    expect(answer.environments.find((entry) => entry.id === "env_gone")).toMatchObject({ life: "destroyed", threadCounts: { live: 1 } });
    expect(answer.environments.find((entry) => entry.id === "env_wt02")).toMatchObject({ activeAt: null, updatedAt: 300, threads: [] });
  });

  it("answers not found for an unknown thread and invalid for a malformed id", async () => {
    const { source } = fakeBb();
    expect(await source.environments("thr_nobody", false)).toMatchObject({ ok: false, reason: "not-found" });
    expect(await source.environments("../etc", false)).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("reads the default view's details for the markdown fallback", async () => {
    const { source } = fakeBb();
    const answer = await source.environments("thr_mine00", true);
    if (!answer.ok) throw new Error(answer.message);
    // The default view: environments with live threads (env_wt02 has none).
    expect(answer.environments.map((entry) => [entry.id, entry.detail !== null])).toEqual([
      ["env_main", true],
      ["env_wt01", true],
      ["env_gone", true],
      ["env_wt02", false],
    ]);
  });
});

describe("environments: one environment's detail", () => {
  it("answers not found for another project's environment, without reading its status", async () => {
    const { source, calls } = fakeBb();
    expect(await source.environment("thr_mine00", "env_other")).toEqual({ ok: false, reason: "not-found", message: "No such environment in this project" });
    expect(await source.environment("thr_mine00", "env_nope")).toMatchObject({ ok: false, reason: "not-found" });
    expect(await source.environment("thr_mine00", "x")).toMatchObject({ ok: false, reason: "invalid" });
    expect(await source.environment("thr_nobody", "env_wt01")).toMatchObject({ ok: false, reason: "not-found" });
    expect(calls.some((call) => call.method === "environments.status")).toBe(false);
  });

  it("reads a worktree's status against its base and its pull request", async () => {
    const { source, calls } = fakeBb();
    const detail = (await source.environment("thr_mine00", "env_wt01")) as EnvironmentDetail;
    expect(detail.checkout).toEqual({
      ok: true,
      branch: "wt/env_wt01",
      checkout: "branch",
      head: "82af8f0",
      defaultBranch: "main",
      base: "main",
      onBase: false,
      ahead: 2,
      behind: 1,
      uncommitted: { files: 2, additions: 12, deletions: 3, complete: true },
    });
    expect(detail.pull).toMatchObject({ ok: true, pullRequest: { number: 424, state: "draft", checks: { state: "failing", failed: 1, passed: 3 } } });
    expect(calls.find((call) => call.method === "environments.status")?.args).toEqual({ environmentId: "env_wt01", mergeBaseBranch: "main" });
  });

  it("doesn't look for a pull request on the default branch", async () => {
    const { source, calls } = fakeBb();
    const detail = (await source.environment("thr_mine00", "env_main")) as EnvironmentDetail;
    expect(detail.checkout).toMatchObject({ ok: true, onBase: true, ahead: null, behind: null });
    expect(detail.pull).toBeNull();
    expect(calls.some((call) => call.method === "environments.pullRequest")).toBe(false);
  });

  it("says a missing workspace folder honestly", async () => {
    const { source } = fakeBb({
      status: () => ({
        outcome: "unavailable",
        failure: { code: "path_not_found", workspacePath: "/work/env_wt01", message: "Unmanaged workspace path does not exist: /work/env_wt01" },
      }),
    });
    const detail = (await source.environment("thr_mine00", "env_wt01")) as EnvironmentDetail;
    expect(detail.checkout).toEqual({ ok: false, reason: "missing", message: "Workspace folder is gone", path: "/work/env_wt01" });
    expect(detail.pull).toBeNull();
  });

  it("doesn't ask git about a destroyed environment", async () => {
    const { source, calls } = fakeBb();
    const detail = (await source.environment("thr_mine00", "env_gone")) as EnvironmentDetail;
    expect(detail.checkout).toMatchObject({ ok: false, reason: "gone" });
    expect(calls.some((call) => call.method === "environments.status")).toBe(false);
  });

  it("asks again with the default branch when BB has none recorded", async () => {
    const { source, calls } = fakeBbWithoutBase();
    const detail = (await source.environment("thr_mine00", "env_wt01")) as EnvironmentDetail;
    expect(detail.checkout).toMatchObject({ ok: true, base: "main" });
    expect(calls.map((call) => call.args)).toEqual([{ environmentId: "env_wt01" }, { environmentId: "env_wt01", mergeBaseBranch: "main" }]);
    expect(detail.pull).toEqual({ ok: true, pullRequest: null });
  });
});

/** fakeBb whose env_wt01 has neither a default nor a merge-base branch recorded. */
function fakeBbWithoutBase() {
  const calls: { method: string; args: unknown }[] = [];
  const sdk = {
    threads: { get: async () => thread("thr_mine00", "env_main") },
    environments: {
      get: async () => environment("env_wt01", { defaultBranch: null }),
      status: async (args: unknown) => {
        calls.push({ method: "environments.status", args });
        return { outcome: "available", workspace: workspace("wt/env_wt01") };
      },
      pullRequest: async () => ({ outcome: "absent" }),
    },
  };
  return { source: createEnvironmentsSource(sdk as unknown as BbPluginApi["sdk"]), calls };
}

describe("environments: mapping BB's records", () => {
  it("names each kind of environment BB makes", () => {
    const kind = (overrides: Partial<EnvironmentEntry>) => {
      const entry = environment("env_x", overrides);
      return environmentKind(entry, environmentLife(entry));
    };
    expect(kind({ isWorktree: false })).toBe("checkout");
    expect(kind({ isWorktree: false, environmentProviderId: null })).toBe("checkout");
    expect(kind({})).toBe("worktree");
    expect(kind({ environmentProviderId: "git-worktree", workspaceProvisionType: "managed-worktree" })).toBe("managed-worktree");
    expect(kind({ environmentProviderId: "personal-workspace", workspaceProvisionType: "personal", isGitRepo: false, isWorktree: false })).toBe("personal");
    expect(kind({ isWorktree: false, isGitRepo: false })).toBe("folder");
    expect(kind({ isWorktree: false, environmentProviderId: "cloud-sandbox" })).toBe("other");
  });

  it("reads the environment's life from its status, lifecycle and machine", () => {
    const life = (overrides: Partial<EnvironmentEntry>) => environmentLife(environment("env_x", overrides));
    expect(life({})).toBe("ready");
    expect(life({ status: "provisioning" })).toBe("creating");
    expect(life({ status: "error" })).toBe("error");
    expect(life({ lifecycle: { phase: "retiring" } })).toBe("retiring");
    expect(life({ lifecycle: { phase: "destroyed" } })).toBe("destroyed");
    expect(life({ hostLifecycle: "removed" })).toBe("host-gone");
  });

  it("maps every way status can fail", () => {
    expect(checkoutFailure({ outcome: "not_applicable", message: "x" })).toMatchObject({ reason: "not-git" });
    const failed = (code: string) => checkoutFailure({ outcome: "unavailable", failure: { code, message: `${code} message`, workspacePath: "/w" } });
    expect(failed("path_not_found")).toEqual({ ok: false, reason: "missing", message: "Workspace folder is gone", path: "/w" });
    expect(failed("not_git_repo")).toMatchObject({ reason: "not-git" });
    expect(failed("workspace_type_mismatch")).toMatchObject({ reason: "not-git" });
    expect(failed("unknown_environment")).toMatchObject({ reason: "gone" });
    expect(failed("permission_denied")).toEqual({ ok: false, reason: "unavailable", message: "permission_denied message", path: "/w" });
  });

  it("reads detached and unborn checkouts", () => {
    expect(checkoutStatus(workspace("x", { checkout: { kind: "detached", headSha: "abcdef0123" } }), "main")).toMatchObject({
      branch: null,
      checkout: "detached",
      head: "abcdef0",
      onBase: false,
    });
    expect(checkoutStatus(workspace("x", { checkout: { kind: "unborn", branchName: "main" }, mergeBase: null }), "main")).toMatchObject({
      branch: "main",
      checkout: "unborn",
      head: null,
      onBase: true,
    });
    expect(checkoutStatus(workspace("feat", { mergeBase: null }), "main")).toMatchObject({ ahead: null, behind: null });
  });

  it("runs at most `limit` at a time and keeps the order", async () => {
    let running = 0;
    let peak = 0;
    const gates = new Map<number, () => void>();
    const all = mapLimit([1, 2, 3, 4, 5], 2, async (value) => {
      running += 1;
      peak = Math.max(peak, running);
      // The project's TypeScript lib predates Promise.withResolvers.
      await new Promise<void>((resolve) => gates.set(value, resolve));
      running -= 1;
      return value * 10;
    });
    // Finish out of order: each release lets the next item start.
    for (const value of [2, 1, 4, 3, 5]) {
      while (!gates.has(value)) await Promise.resolve();
      gates.get(value)?.();
    }
    expect(await all).toEqual([10, 20, 30, 40, 50]);
    expect(peak).toBe(2);
    expect(await mapLimit([], 3, async () => 1)).toEqual([]);
  });
});
