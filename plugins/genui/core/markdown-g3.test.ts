import { describe, expect, it } from "vitest";
import type { EnvironmentDetail, EnvironmentInfo } from "./environments";
import { compile, evaluate, formatDiagnostics, initialState, toMarkdown } from "./index";
import { projectRequests, toMarkdownWithProject } from "./markdown";
import { projectRequestKey, type ProjectResult } from "./project";
import type { UiNode } from "./types";

function roots(source: string): UiNode[] {
  const result = compile(source);
  if (result.program === null) throw new Error(formatDiagnostics(result.diagnostics));
  return evaluate(result.program, initialState(result.program)).roots;
}

function markdown(source: string, answer: ProjectResult): string {
  const nodes = roots(source);
  return toMarkdownWithProject(nodes, new Map(), new Map(projectRequests(nodes).map((request) => [projectRequestKey(request), answer] as const)));
}

const NOW = Date.UTC(2026, 9, 10, 12);
const MINUTE = 60_000;

function environment(id: string, overrides: Partial<EnvironmentInfo>): EnvironmentInfo {
  return {
    id,
    name: null,
    kind: "worktree",
    provider: "project-checkout",
    path: `/work/${id}`,
    branch: null,
    defaultBranch: "main",
    base: "main",
    git: true,
    life: "ready",
    current: false,
    threads: [],
    threadCounts: { total: 0, live: 0, running: 0, needsInput: 0 },
    activeAt: null,
    updatedAt: NOW - 600 * MINUTE,
    detail: null,
    ...overrides,
  };
}

function detail(id: string, rest: Pick<EnvironmentDetail, "checkout" | "pull">): EnvironmentDetail {
  return { ok: true, id, ...rest, fetchedAt: NOW };
}

/** The orbit-web project as BB answered on 2026-10-10: the checkout, a worktree with a PR, a worktree whose folder is gone, one without threads. */
const VIEW: ProjectResult = {
  ok: true,
  fetchedAt: NOW,
  threadsTruncated: false,
  environments: [
    environment("env_nhx5reduyi", {
      kind: "checkout",
      path: "/Users/me/Projects/orbit-web",
      branch: "main",
      current: true,
      threads: [
        { id: "thr_q4m8x2kd7a", title: "Sketch the team’s onboarding checklist", status: "active", needsInput: false, archived: false, subthread: false, activeAt: NOW - 4 * MINUTE },
        { id: "thr_7wb3n5ty2e", title: "Speed up the pricing page on mobile", status: "idle", needsInput: false, archived: false, subthread: false, activeAt: NOW - 90 * MINUTE },
        { id: "thr_h2c6v9pz4r", title: "Fix *the* header", status: "idle", needsInput: true, archived: false, subthread: true, activeAt: NOW - 95 * MINUTE },
        { id: "thr_old0000a", title: "Old work", status: "idle", needsInput: false, archived: false, subthread: false, activeAt: NOW - 99 * MINUTE },
      ],
      threadCounts: { total: 10, live: 9, running: 1, needsInput: 1 },
      activeAt: NOW - 4 * MINUTE,
      detail: detail("env_nhx5reduyi", {
        checkout: {
          ok: true,
          branch: "main",
          checkout: "branch",
          head: "82af8f0",
          defaultBranch: "main",
          base: "main",
          onBase: true,
          ahead: null,
          behind: null,
          uncommitted: { files: 0, additions: 0, deletions: 0, complete: true },
        },
        pull: null,
      }),
    }),
    environment("env_mv63yx3dqw", {
      branch: "feat/403-offline-search",
      base: "release-1.5",
      threads: [{ id: "thr_n5j1u8fw3m", title: "Continue Orbit issue #404", status: "idle", needsInput: false, archived: false, subthread: false, activeAt: NOW - 60 * MINUTE }],
      threadCounts: { total: 1, live: 1, running: 0, needsInput: 0 },
      activeAt: NOW - 60 * MINUTE,
      detail: detail("env_mv63yx3dqw", {
        checkout: {
          ok: true,
          branch: "feat/403-offline-search",
          checkout: "branch",
          head: "1a2b3c4",
          defaultBranch: "release-1.5",
          base: "release-1.5",
          onBase: false,
          ahead: 32,
          behind: 1,
          uncommitted: { files: 40, additions: 2782, deletions: 312, complete: true },
        },
        pull: {
          ok: true,
          pullRequest: {
            number: 424,
            title: "Offline search index",
            url: "https://github.com/acme/orbit/pull/424",
            state: "draft",
            baseRef: "release-1.5",
            headRef: "feat/403-offline-search",
            checks: { state: "failing", passed: 3, failed: 1, pending: 0, total: 4 },
            review: { state: "none", requests: 0 },
            mergeability: "draft",
            attention: "draft",
            autoMerge: false,
            inMergeQueue: false,
            updatedAt: NOW - 60 * MINUTE,
          },
        },
      }),
    }),
    environment("env_rsrp3q7w77", {
      branch: "wt/flowers-day",
      threads: [{ id: "thr_flowers0", title: "Execute task instructions", status: "idle", needsInput: false, archived: false, subthread: true, activeAt: NOW - 18 * 24 * 60 * MINUTE }],
      threadCounts: { total: 1, live: 1, running: 0, needsInput: 0 },
      activeAt: NOW - 18 * 24 * 60 * MINUTE,
      detail: detail("env_rsrp3q7w77", {
        checkout: { ok: false, reason: "missing", message: "Workspace folder is gone", path: "/Users/me/Projects/orbit-web-wt/flowers-day" },
        pull: null,
      }),
    }),
    environment("env_bkjcvn6mvp", { branch: "wt/copy" }),
  ],
};

describe("toMarkdown: Environments", () => {
  it("asks for one environments read", () => {
    expect(projectRequests(roots(`Card("x", [Environments(), Environments()])`))).toEqual([{ kind: "environments" }]);
  });

  it("says where the data is without an answer, and why when BB failed", () => {
    expect(toMarkdown(roots(`Environments()`))).toBe("_This project's environments, their threads and changes: open the reply in BB to see them._");
    expect(markdown(`Environments()`, { ok: false, reason: "not-found", message: "BB has no such thread" })).toBe("**Environments** · _BB has no such thread_");
  });

  it("lists the environments with live threads, their git line and threads, and counts the rest", () => {
    expect(markdown(`Environments()`, VIEW)).toBe(
      [
        "**Environments** · 3 with live threads of 4 · 1 running",
        "",
        [
          "- **main** (Project checkout · orbit-web, this thread) · clean · default branch · 1 running · 1 needs input · 9 live · 1 archived · 4 min ago",
          "  - Sketch the team’s onboarding checklist — Running",
          "  - Speed up the pricing page on mobile — Idle",
          "  - ↳ Fix \\*the\\* header — Needs input",
          "- **feat/403-offline-search** (Worktree) · 40 files +2,782 −312 uncommitted · 32 ahead, 1 behind release-1.5 · PR [#424](https://github.com/acme/orbit/pull/424) Draft, checks failing · 1 live · 1 h ago",
          "  - Continue Orbit issue #404 — Idle",
          "- **wt/flowers-day** (Worktree) · _Workspace folder is gone_ (`/Users/me/Projects/orbit-web-wt/flowers-day`) · 1 live · Sep 22",
          "  - ↳ Execute task instructions — Idle",
        ].join("\n"),
        "",
        "_… and 1 more environment without live threads_",
      ].join("\n"),
    );
  });

  it("lists every environment when none has a live thread", () => {
    const idle: ProjectResult = { ok: true, fetchedAt: NOW, threadsTruncated: false, environments: [environment("env_bkjcvn6mvp", { branch: "wt/copy", life: "retiring" })] };
    expect(markdown(`Environments()`, idle)).toBe("**Environments** · 1\n\n- **wt/copy** (Worktree, Being removed) · No threads");
    expect(markdown(`Environments()`, { ok: true, fetchedAt: NOW, threadsTruncated: false, environments: [] })).toBe("**Environments** · none in this project");
  });
});
