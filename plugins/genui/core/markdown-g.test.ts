import { describe, expect, it } from "vitest";
import { compile, evaluate, formatDiagnostics, initialState, toMarkdown } from "./index";
import { projectRequests, toMarkdownWithProject } from "./markdown";
import { projectRequestKey, type ProjectRequest, type ProjectResult } from "./project";
import type { UiNode } from "./types";

function roots(source: string): UiNode[] {
  const result = compile(source);
  if (result.program === null) throw new Error(formatDiagnostics(result.diagnostics));
  return evaluate(result.program, initialState(result.program)).roots;
}

/** The markdown with BB's answers given per request. */
function markdown(source: string, answer: (request: ProjectRequest) => ProjectResult): string {
  const nodes = roots(source);
  const answers = new Map(projectRequests(nodes).map((request) => [projectRequestKey(request), answer(request)] as const));
  return toMarkdownWithProject(nodes, new Map(), answers);
}

const NOW = Date.UTC(2026, 9, 10, 12);

describe("toMarkdown: project components", () => {
  it("collects one read per distinct request, nested ones included, and none for unreadable props", () => {
    expect(projectRequests(roots(`Card("x", [Changes(), Changes(), Changes("uncommitted", ["src"]), Tabs(["a"], [Threads()]), Changes("main")])`))).toEqual([
      { kind: "changes", target: { kind: "branch" }, paths: null },
      { kind: "changes", target: { kind: "uncommitted" }, paths: ["src"] },
      { kind: "threads", ids: null },
    ]);
  });

  it("says where the data is when nothing was read, and why props are unusable", () => {
    expect(toMarkdown(roots(`Changes()`))).toBe("_The changes in this thread's checkout: open the reply in BB to see them._");
    expect(toMarkdown(roots(`Changes("HEAD~1")`))).toBe(
      '_(error: Changes target must be omitted, "uncommitted" or a commit sha, not "HEAD~1")_',
    );
  });

  it("renders Changes as a table of files with counts, binary files without counts", () => {
    const text = markdown(`Changes(paths: ["src"])`, () => ({
      ok: true,
      scope: { kind: "branch", branch: "feat/x", head: null, base: "main", onBase: false },
      files: [
        { path: "src/a.ts", previousPath: null, kind: "modified", additions: 3, deletions: 1, untracked: false, diff: "inline" },
        { path: "src/b|c.ts", previousPath: "old/b.ts", kind: "renamed", additions: 0, deletions: 2, untracked: false, diff: "on-demand" },
        { path: "src/logo.png", previousPath: null, kind: "added", additions: 0, deletions: 0, untracked: true, diff: "binary" },
      ],
      totalFiles: 9,
      filter: ["src"],
      listTruncated: false,
      patches: [],
      livePatches: true,
      takenAt: NOW,
      stored: false,
    }));
    expect(text).toBe(`**Changes** · feat/x vs main, incl. uncommitted · 3 files, +3 −3 · paths: src (3 of 9 files)

| File | Change | + | − |
| --- | --- | --- | --- |
| \`src/a.ts\` | Modified | +3 | −1 |
| \`src/b\\|c.ts\` (from \`old/b.ts\`) | Renamed | +0 | −2 |
| \`src/logo.png\` | Added, untracked, binary | — | — |`);
  });

  it("renders Commits newest first up to the limit, with ahead and behind", () => {
    const commit = (n: number) => ({ sha: `${n}`.repeat(40), shortSha: `${n}`.repeat(7), subject: `Change ${n}`, author: "Ana", authoredAt: NOW - n * 3_600_000 });
    const text = markdown(`Commits(2)`, () => ({
      ok: true,
      branch: "feat/x",
      checkout: "branch",
      head: "1111111",
      base: "main",
      onBase: false,
      ahead: 3,
      behind: 4,
      commits: [commit(1), commit(2), commit(3)],
      commitsTruncated: false,
      takenAt: NOW,
      stored: true,
    }));
    expect(text).toBe(`**Commits** · feat/x · 3 ahead, 4 behind main

- \`1111111\` Change 1 — Ana, 1 h ago
- \`2222222\` Change 2 — Ana, 2 h ago

_… and 1 more commit_`);
  });

  it("renders PullRequest as one line with its link, and a missing one plainly", () => {
    const pr = {
      number: 367,
      title: "World sheets",
      url: "https://github.com/o/r/pull/367",
      state: "draft",
      baseRef: "main",
      headRef: "feat/x",
      checks: { state: "failing", passed: 3, failed: 2, pending: 0, total: 5 },
      review: { state: "none", requests: 0 },
      mergeability: "conflicts",
      attention: "conflicts",
      autoMerge: false,
      inMergeQueue: false,
      updatedAt: NOW,
    } as const;
    expect(markdown(`PullRequest()`, () => ({ ok: true, branch: "feat/x", pullRequest: pr, fetchedAt: NOW }))).toBe(
      "**Pull request** [#367 World sheets](https://github.com/o/r/pull/367) · Draft · main ← feat/x · Checks failing (2 failed · 3 passed) · No reviews · Conflicts · needs: Has merge conflicts",
    );
    expect(markdown(`PullRequest()`, () => ({ ok: true, branch: "feat/x", pullRequest: null, fetchedAt: NOW }))).toBe(
      "**Pull request** · none for feat/x",
    );
    expect(markdown(`PullRequest()`, () => ({ ok: false, reason: "not-git", message: "This thread's environment isn't a git checkout" }))).toBe(
      "**Pull request** · _This thread's environment isn't a git checkout_",
    );
  });

  it("renders Threads as a list with status, agent and activity; ids it can't see say so", () => {
    const text = markdown(`Threads(["thr_aaaa1", "thr_other"])`, () => ({
      ok: true,
      mode: "ids",
      threads: [
        {
          found: true,
          id: "thr_aaaa1",
          title: "Build G",
          status: "active",
          needsInput: false,
          archived: false,
          provider: { id: "claude-code", name: "Claude Code", logoUrl: null },
          model: "opus",
          reasoning: null,
          updatedAt: NOW - 5 * 60_000,
          lastMessage: null,
          pending: null,
          runningWorkers: 0,
        },
        { found: false, id: "thr_other" },
      ],
      truncated: false,
      fetchedAt: NOW,
    }));
    expect(text).toBe(`**Threads**

- **Build G** — Running · Claude Code, opus · 5 min ago
- \`thr_other\` — not found in this project`);
  });

  it("renders a thread's pending question, its latest message and an idle parent waiting on its workers", () => {
    const base = {
      found: true,
      archived: false,
      provider: { id: "claude-code", name: "Claude Code", logoUrl: null },
      model: "opus",
      reasoning: "high",
      updatedAt: NOW - 2 * 60_000,
      lastMessage: null,
      pending: null,
      runningWorkers: 0,
    } as const;
    const text = markdown(`Threads(["thr_lane01", "thr_parent1"])`, () => ({
      ok: true,
      mode: "ids",
      threads: [
        {
          ...base,
          id: "thr_lane01",
          title: "Lane 2",
          status: "active",
          needsInput: true,
          pending: { kind: "question", action: "Answer a question", text: "Ship *both* lanes?", code: false, options: ["Yes", "No"], more: 1, since: NOW },
          lastMessage: { text: "## Done\n\nBuilt `app` on **main**.", truncated: false },
        },
        { ...base, id: "thr_parent1", title: "Orchestrator", status: "idle", needsInput: false, runningWorkers: 3 },
      ],
      truncated: false,
      fetchedAt: NOW,
    }));
    expect(text).toBe(`**Threads**

- **Lane 2** — Needs input · Claude Code, opus, high reasoning · 2 min ago
  - Needs you: Answer a question: Ship \\*both\\* lanes? (Yes / No) · 1 more waiting
  - Latest message: Done Built app on main.
- **Orchestrator** — Waiting on 3 running workers · Claude Code, opus, high reasoning · 2 min ago`);
  });
});
