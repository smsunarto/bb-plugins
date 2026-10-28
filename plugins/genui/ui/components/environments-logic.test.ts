import { describe, expect, it } from "vitest";
import type { EnvironmentInfo } from "../../core/environments";
import { detailsDue, ENVIRONMENT_PAGE, LIVE_DETAIL_MS, shownEnvironments } from "./environments-logic";

function environment(id: string, live: number, running = 0): EnvironmentInfo {
  return {
    id,
    name: null,
    kind: "worktree",
    provider: null,
    path: null,
    branch: id,
    defaultBranch: "main",
    base: "main",
    git: true,
    life: "ready",
    current: false,
    threads: [],
    threadCounts: { total: live, live, running, needsInput: 0 },
    activeAt: null,
    updatedAt: 1,
    detail: null,
  };
}

describe("Environments: rows shown", () => {
  const many = [environment("env_live1", 1), environment("env_live2", 2), ...Array.from({ length: 60 }, (_, index) => environment(`env_idle${index}`, 0))];

  it("shows live environments first, with how many the default view leaves out", () => {
    const shown = shownEnvironments(many, false, 1);
    expect(shown.rows.map((row) => row.id)).toEqual(["env_live1", "env_live2"]);
    expect(shown).toMatchObject({ hidden: 60, more: 0 });
  });

  it("pages every environment once all are shown", () => {
    expect(shownEnvironments(many, true, 1)).toMatchObject({ hidden: 0, more: 62 - ENVIRONMENT_PAGE });
    expect(shownEnvironments(many, true, 1).rows).toHaveLength(ENVIRONMENT_PAGE);
    expect(shownEnvironments(many, true, 3)).toMatchObject({ hidden: 0, more: 0 });
    expect(shownEnvironments(many, true, 3).rows).toHaveLength(62);
  });

  it("shows all when no environment has a live thread", () => {
    const idle = many.slice(2, 5);
    expect(shownEnvironments(idle, false, 1)).toMatchObject({ rows: idle, hidden: 0, more: 0 });
    expect(shownEnvironments([], false, 1)).toMatchObject({ rows: [], hidden: 0, more: 0 });
  });
});

describe("Environments: details due", () => {
  const rows = new Map([environment("env_a", 1, 1), environment("env_b", 1), environment("env_c", 0)].map((row) => [row.id, row]));
  const now = 1_000_000;

  it("reads rows on screen never read, in screen order, skipping ones being read and unknown ids", () => {
    expect(detailsDue(["env_c", "env_a", "env_b", "env_gone"], rows, new Map(), new Set(["env_b"]), now)).toEqual(["env_c", "env_a"]);
  });

  it("reads again only rows with a running thread whose detail is stale", () => {
    const readAt = new Map([
      ["env_a", now - LIVE_DETAIL_MS - 1],
      ["env_b", now - LIVE_DETAIL_MS * 10],
      ["env_c", now],
    ]);
    expect(detailsDue(["env_a", "env_b", "env_c"], rows, readAt, new Set(), now)).toEqual(["env_a"]);
    expect(detailsDue(["env_a"], rows, new Map([["env_a", now - 1]]), new Set(), now)).toEqual([]);
  });
});
