import { describe, expect, it } from "vitest";
import {
  aheadBehindLabel,
  byActivity,
  defaultEnvironments,
  environmentTitle,
  folderName,
  kindLabel,
  openingThread,
  threadSummary,
  uncommittedLabel,
  type CheckoutStatus,
  type EnvironmentInfo,
  type EnvironmentThread,
} from "./environments";

function thread(id: string, overrides: Partial<EnvironmentThread> = {}): EnvironmentThread {
  return { id, title: id, status: "idle", needsInput: false, archived: false, subthread: false, activeAt: 1, ...overrides };
}

function environmentFixture(id: string, overrides: Partial<EnvironmentInfo> = {}): EnvironmentInfo {
  return {
    id,
    name: null,
    kind: "worktree",
    provider: "project-checkout",
    path: `/work/${id}`,
    branch: `wt/${id}`,
    defaultBranch: "main",
    base: "main",
    git: true,
    life: "ready",
    current: false,
    threads: [],
    threadCounts: { total: 0, live: 0, running: 0, needsInput: 0 },
    activeAt: null,
    updatedAt: 1,
    detail: null,
    ...overrides,
  };
}

const STATUS: CheckoutStatus = {
  ok: true,
  branch: "feat/x",
  checkout: "branch",
  head: "82af8f0",
  defaultBranch: "main",
  base: "main",
  onBase: false,
  ahead: 3,
  behind: 1,
  uncommitted: { files: 4, additions: 120, deletions: 8, complete: true },
};

describe("environments: shared wording and order", () => {
  it("shows environments with live threads by default, all when none has one", () => {
    const live = environmentFixture("env_live", { threadCounts: { total: 2, live: 1, running: 0, needsInput: 0 } });
    const archived = environmentFixture("env_arch", { threadCounts: { total: 1, live: 0, running: 0, needsInput: 0 } });
    const empty = environmentFixture("env_none");
    expect(defaultEnvironments([live, archived, empty])).toEqual({ shown: [live], filtered: true });
    expect(defaultEnvironments([archived, empty])).toEqual({ shown: [archived, empty], filtered: false });
    expect(defaultEnvironments([live])).toEqual({ shown: [live], filtered: false });
  });

  it("orders by thread activity, then environments without threads by their last change", () => {
    const rows = [
      environmentFixture("env_b", { activeAt: null, updatedAt: 50 }),
      environmentFixture("env_a", { activeAt: 10 }),
      environmentFixture("env_c", { activeAt: 30 }),
      environmentFixture("env_d", { activeAt: null, updatedAt: 90 }),
      environmentFixture("env_e", { activeAt: 30 }),
    ];
    expect([...rows].sort(byActivity).map((row) => row.id)).toEqual(["env_c", "env_e", "env_a", "env_d", "env_b"]);
  });

  it("opens the first live thread, else the newest archived one", () => {
    expect(openingThread(environmentFixture("env_x", { threads: [thread("thr_live"), thread("thr_arch", { archived: true })] }))?.id).toBe("thr_live");
    expect(openingThread(environmentFixture("env_x", { threads: [thread("thr_arch", { archived: true })] }))?.id).toBe("thr_arch");
    expect(openingThread(environmentFixture("env_x"))).toBeNull();
  });

  it("names an environment by branch, name, folder or id", () => {
    expect(environmentTitle(environmentFixture("env_x"))).toBe("wt/env_x");
    expect(environmentTitle(environmentFixture("env_x", { branch: null, name: "Scratch" }))).toBe("Scratch");
    expect(environmentTitle(environmentFixture("env_x", { branch: null, path: "/Users/me/.bb/personal-workspaces/env_x/" }))).toBe("env_x");
    expect(environmentTitle(environmentFixture("env_x", { branch: null, path: null }))).toBe("env_x");
    expect(folderName("C:\\work\\app")).toBe("app");
    expect(folderName(null)).toBeNull();
  });

  it("labels the kind, with the folder of a checkout and the provider of other kinds", () => {
    expect(kindLabel(environmentFixture("env_x", { kind: "checkout", path: "/p/orbit-operator", branch: "main" }))).toBe("Project checkout · orbit-operator");
    expect(kindLabel(environmentFixture("env_x", { kind: "checkout", path: "/p/main", branch: "main" }))).toBe("Project checkout");
    expect(kindLabel(environmentFixture("env_x", { kind: "managed-worktree" }))).toBe("Managed worktree");
    expect(kindLabel(environmentFixture("env_x", { kind: "other", provider: "cloud-sandbox" }))).toBe("cloud-sandbox");
  });

  it("sums up threads, uncommitted work and position", () => {
    expect(threadSummary(environmentFixture("env_x"))).toBe("No threads");
    expect(threadSummary(environmentFixture("env_x", { threadCounts: { total: 5, live: 3, running: 2, needsInput: 1 } }))).toBe(
      "2 running · 1 needs input · 3 live · 2 archived",
    );
    expect(uncommittedLabel(STATUS)).toBe("4 files +120 −8 uncommitted");
    expect(uncommittedLabel({ ...STATUS, uncommitted: { files: 0, additions: 0, deletions: 0, complete: true } })).toBe("clean");
    expect(aheadBehindLabel(STATUS)).toBe("3 ahead, 1 behind main");
    expect(aheadBehindLabel({ ...STATUS, ahead: 0, behind: 0 })).toBe("even with main");
    expect(aheadBehindLabel({ ...STATUS, onBase: true })).toBe("");
    expect(aheadBehindLabel({ ...STATUS, ahead: null })).toBe("");
  });
});
