import { describe, expect, it } from "vitest";
import {
  matchesPathFilter,
  parseChangesTarget,
  parseCommitLimit,
  parsePathFilter,
  parseThreadIds,
  pullRequestSettling,
  relativeTime,
  scopeLabel,
  type PullRequestInfo,
} from "./project";

describe("Changes target", () => {
  it("reads omitted, uncommitted and commit shas; refuses anything else", () => {
    expect(parseChangesTarget(undefined)).toEqual({ ok: true, value: { kind: "branch" } });
    expect(parseChangesTarget(null)).toEqual({ ok: true, value: { kind: "branch" } });
    expect(parseChangesTarget(" Uncommitted ")).toEqual({ ok: true, value: { kind: "uncommitted" } });
    expect(parseChangesTarget("A1B2C3D")).toEqual({ ok: true, value: { kind: "commit", sha: "a1b2c3d" } });
    // Too short to name one commit, not hex, a ref name: refused rather than guessed.
    for (const bad of ["a1b2c3", "a1b2c3g", "main", "HEAD~1", 1234567]) {
      expect(parseChangesTarget(bad).ok, String(bad)).toBe(false);
    }
  });
});

describe("Changes paths", () => {
  it("normalizes prefixes and keeps exact files and whole directories only", () => {
    const parsed = parsePathFilter(["./src/core/", "README.md", "src/core"]);
    expect(parsed).toEqual({ ok: true, value: ["src/core", "README.md"] });
    const filter = parsed.ok ? parsed.value : null;
    expect(matchesPathFilter("src/core/a.ts", filter)).toBe(true);
    expect(matchesPathFilter("src/core", filter)).toBe(true);
    // A sibling sharing the prefix's spelling is not inside it.
    expect(matchesPathFilter("src/core-old/a.ts", filter)).toBe(false);
    expect(matchesPathFilter("docs/README.md", filter)).toBe(false);
  });

  it("treats an empty list as no filter and refuses non-paths", () => {
    expect(parsePathFilter([])).toEqual({ ok: true, value: null });
    expect(parsePathFilter("src").ok).toBe(false);
    expect(parsePathFilter([1]).ok).toBe(false);
    expect(parsePathFilter(["./"]).ok).toBe(false);
  });
});

describe("Commits limit and Threads ids", () => {
  it("caps the limit and refuses zero, negatives and text", () => {
    expect(parseCommitLimit(5.7)).toEqual({ ok: true, value: 5 });
    expect(parseCommitLimit(1e9)).toEqual({ ok: true, value: 500 });
    expect(parseCommitLimit(0).ok).toBe(false);
    expect(parseCommitLimit("5").ok).toBe(false);
  });

  it("drops repeated ids and refuses non-strings", () => {
    expect(parseThreadIds(["thr_abc123", " thr_abc123", "thr_def456"])).toEqual({ ok: true, value: ["thr_abc123", "thr_def456"] });
    expect(parseThreadIds(["thr_abc123", 4]).ok).toBe(false);
  });
});

describe("scope labels", () => {
  it("names the comparison the header shows", () => {
    expect(scopeLabel({ kind: "branch", branch: "feat/x", head: null, base: "main", onBase: false })).toBe("feat/x vs main, incl. uncommitted");
    expect(scopeLabel({ kind: "branch", branch: "main", head: null, base: "main", onBase: true })).toBe("main, uncommitted");
    expect(scopeLabel({ kind: "branch", branch: null, head: "a1b2c3d", base: "main", onBase: false })).toBe(
      "detached a1b2c3d vs main, incl. uncommitted",
    );
    expect(scopeLabel({ kind: "commit", sha: "a1b2c3d4e5f6", subject: null })).toBe("commit a1b2c3d");
    expect(scopeLabel({ kind: "uncommitted", branch: "main", unborn: true })).toBe("uncommitted, no commits yet");
  });
});

describe("pull request polling", () => {
  const base: PullRequestInfo = {
    number: 1,
    title: "t",
    url: "https://github.com/o/r/pull/1",
    state: "open",
    baseRef: "main",
    headRef: "feat",
    checks: { state: "passing", passed: 3, failed: 0, pending: 0, total: 3 },
    review: { state: "none", requests: 0 },
    mergeability: "mergeable",
    attention: "none",
    autoMerge: false,
    inMergeQueue: false,
    updatedAt: 0,
  };

  it("settles only while checks run, mergeability is computed or the queue holds it, and never once merged", () => {
    expect(pullRequestSettling(base)).toBe(false);
    expect(pullRequestSettling({ ...base, checks: { ...base.checks, state: "pending" } })).toBe(true);
    expect(pullRequestSettling({ ...base, mergeability: "unknown" })).toBe(true);
    expect(pullRequestSettling({ ...base, inMergeQueue: true })).toBe(true);
    expect(pullRequestSettling({ ...base, state: "merged", mergeability: "unknown" })).toBe(false);
  });
});

describe("relative time", () => {
  const now = Date.UTC(2026, 9, 10, 12, 0, 0);
  it("steps from minutes to hours to days to dates", () => {
    expect(relativeTime(now - 30_000, now)).toBe("just now");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3 h ago");
    expect(relativeTime(now - 30 * 3_600_000, now)).toBe("yesterday");
    expect(relativeTime(now - 4 * 86_400_000, now)).toBe("4 days ago");
    expect(relativeTime(Date.UTC(2026, 8, 1, 12), now)).toBe("Sep 1");
    expect(relativeTime(Date.UTC(2025, 8, 1, 12), now)).toBe("Sep 1, 2025");
  });
});
