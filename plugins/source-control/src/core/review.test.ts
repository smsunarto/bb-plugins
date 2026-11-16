import { describe, expect, test } from "vitest";
import type { ChangeKey } from "./ids.ts";
import {
  mergeChanges,
  parseChangeKey,
  parseReviewPath,
  reviewPath,
  startsCollapsed,
  type ChangeRow,
  lineTone,
  workspaceRows,
} from "./review.ts";
import type { Branch, WorkspaceValue } from "./change.ts";

const key = (raw: string) => raw as ChangeKey;

function row(overrides: Partial<ChangeRow> & { key: ChangeKey }): ChangeRow {
  return {
    repo: "smsunarto/bb-plugins",
    title: "t",
    branch: overrides.key.split(":").at(-1)!,
    baseRef: "main",
    number: null,
    url: null,
    author: null,
    state: "local",
    mine: true,
    asked: false,
    stack: null,
    hostId: null,
    line: "",
    chips: [],
    sort: 5,
    updatedAt: null,
    ...overrides,
  };
}

describe("ChangeKey", () => {
  test.each([
    [
      "gh:smsunarto/bb-plugins:smsunarto:scott/route-gh",
      {
        kind: "gh",
        repo: { owner: "smsunarto", name: "bb-plugins" },
        headOwner: "smsunarto",
        branch: "scott/route-gh",
      },
    ],
    [
      "local:host-a:/srv/a:b/.git:feature",
      { kind: "local", hostId: "host-a", commonDir: "/srv/a:b/.git", branch: "feature" },
    ],
    ["gh:nope", null],
  ])("%s", (raw, expected) => {
    expect(parseChangeKey(key(raw))).toEqual(expected);
  });
});

describe("mergeChanges", () => {
  const A = key("gh:smsunarto/bb-plugins:smsunarto:a");
  const B = key("gh:smsunarto/bb-plugins:smsunarto:b");
  const C = key("gh:smsunarto/bb-plugins:smsunarto:c");
  const X = key("gh:acme/api:acme:x");
  const stack = (position: number) => ({ id: "s1", position, size: 2 });
  const host = [
    row({ key: A, hostId: "h1", stack: stack(2), sort: 2 }),
    row({ key: B, hostId: "h1", stack: stack(1), sort: 4 }),
    row({ key: C, hostId: "h2", sort: 1 }),
  ];
  const inbox = [
    row({ key: A, number: 482, state: "draft", line: "Draft", mine: true, sort: 2, hostId: null }),
    row({ key: X, repo: "acme/api", number: 77, state: "open", mine: false, asked: true, sort: 0 }),
  ];

  test("one row per key: the forge's pull request, the checkout's stack and host", () => {
    const merged = mergeChanges([host, inbox], "all");
    const a = merged.order.find((each) => each.key === A)!;
    expect(a).toMatchObject({
      number: 482,
      state: "draft",
      hostId: "h1",
      hosts: ["h1"],
      stack: stack(2),
    });
    expect(merged.counts).toEqual({ all: 4, mine: 3, asked: 1, pinned: 0 });
  });

  test("shelves by repository, closest to shipping first; a stack keeps bottom last", () => {
    const merged = mergeChanges([host, inbox], "all");
    expect(merged.shelves.map((shelf) => shelf.repo)).toEqual(["acme/api", "smsunarto/bb-plugins"]);
    const shelf = merged.shelves[1]!;
    expect(
      shelf.groups.map((group) => ("rows" in group ? group.rows.map((r) => r.key) : group.key)),
    ).toEqual([C, [A, B]]);
  });

  test.each(["merged", "closed"] as const)(
    "a %s pull request is left out, even when a checkout still has its branch",
    (state) => {
      const merged = mergeChanges(
        [
          [row({ key: C, hostId: "h2" })],
          [row({ key: C, number: 9, state, sort: 9, pinned: true })],
        ],
        "all",
      );
      expect(merged.order).toEqual([]);
      expect(merged.counts).toEqual({ all: 0, mine: 0, asked: 0, pinned: 0 });
    },
  );

  test("filters keep their counts", () => {
    const asked = mergeChanges([host, inbox], "asked");
    expect(asked.order.map((each) => each.key)).toEqual([X]);
    expect(asked.counts).toEqual({ all: 4, mine: 3, asked: 1, pinned: 0 });
  });

  const failed = { id: "failed", label: "1 Failed", tone: "error", icon: "cross" } as const;
  const passed = { id: "passed", label: "Passed", tone: "success", icon: "check" } as const;
  test.each([
    ["after problems, before good news", "open", [failed, passed], ["failed", "asked", "passed"]],
    ["alone", "open", [], ["asked"]],
    ["not on a draft", "draft", [passed], ["passed"]],
  ] as const)("an asked pull request says so: %s", (_, state, chips, ids) => {
    const merged = mergeChanges(
      [[row({ key: X, number: 77, state, asked: true, chips: [...chips] })]],
      "all",
    );
    expect(merged.order[0]!.chips.map((chip) => chip.id)).toEqual(ids);
  });
});

describe("deep links", () => {
  const K = key("gh:smsunarto/bb-plugins:smsunarto:scott/route-gh");
  // bb encodes each segment of what toPluginPanel is given once more.
  const viaBb = (subPath: string) => subPath.split("/").map(encodeURIComponent).join("/");

  test.each([
    [{ key: K }, { key: K, tab: "overview", commit: null, path: null, line: null }],
    [
      { key: K, tab: "files" as const, path: "src/a b/c.ts", line: 46 },
      { key: K, tab: "files", commit: null, path: "src/a b/c.ts", line: 46 },
    ],
    [
      { key: K, tab: "commits" as const, commit: "c0ffee" },
      { key: K, tab: "commits", commit: "c0ffee", path: null, line: null },
    ],
  ])("%o round-trips", (location, expected) => {
    expect(parseReviewPath(viaBb(reviewPath(location)))).toEqual(expected);
  });

  test("anything else is the list", () => {
    expect(parseReviewPath("")).toMatchObject({ key: null });
    expect(parseReviewPath("c/%E0%A4%A")).toMatchObject({ key: null });
  });
});

test.each([
  ["pnpm-lock.yaml", true],
  ["apps/web/package-lock.json", true],
  ["dist/app.js", true],
  ["src/app.min.js", true],
  ["src/app.ts", false],
])("%s starts collapsed: %s", (path, expected) => {
  expect(startsCollapsed(path)).toBe(expected);
});

describe("the phone line's tone", () => {
  const chip = (id: string, tone: "neutral" | "warning" | "error" | "success" | "merged") =>
    ({ id, label: id, tone, icon: null }) as const;
  test.each([
    ["my own pull request waiting on review", [chip("passed", "success")], "neutral"],
    ["my own pull request with checks running", [chip("running", "warning")], "neutral"],
    ["a review asked of me", [chip("asked", "warning"), chip("passed", "success")], "warning"],
    ["failed checks win over an ask", [chip("failed", "error"), chip("asked", "warning")], "error"],
    ["ready to merge", [chip("ready", "success"), chip("passed", "success")], "success"],
    ["merged", [chip("merged", "merged")], "merged"],
    ["local, not pushed", [chip("local", "neutral")], "neutral"],
  ] as const)("%s", (_, chips, tone) => {
    expect(lineTone({ chips: [...chips] })).toBe(tone);
  });
});

describe("workspaceRows", () => {
  function branch(name: string, commits: number): Branch {
    return {
      name,
      head: commits > 0 ? "c0ffee" : null,
      remote: null,
      status: commits > 0 ? "unpushed" : "empty",
      push: "none",
      ahead: 0,
      behind: 0,
      newUpstream: 0,
      reviewId: null,
      commits: Array.from({ length: commits }, (_, n) => ({
        id: `c0ffee${n}`,
        subject: `${name} commit ${n}`,
        createdAt: null,
        conflicted: false,
      })),
      moreCommits: 0,
      upstreamCommits: [],
    };
  }

  function gitbutler(branches: Branch[], uncommitted = 0): WorkspaceValue {
    return {
      provider: "gitbutler",
      path: "/srv/bb-plugins",
      commonDir: "/srv/bb-plugins/.git",
      checkedOut: null,
      github: null,
      uncommitted: Array.from({ length: uncommitted }, (_, n) => ({
        path: `f${n}.ts`,
        kind: "modified" as const,
      })),
      moreUncommitted: 0,
      conflicted: [],
      stacks: [{ key: branches.at(-1)!.name, branches, assigned: [] }],
      target: { ref: "origin/main", head: "aaa111", behind: 0, base: null, lastFetched: null },
    };
  }

  const rows = (workspace: WorkspaceValue, listed: boolean) =>
    workspaceRows({ hostId: "h1", workspace, forgeOf: () => null, listed });

  test("the nav's rows leave out empty branches and count the stack without them", () => {
    const workspace = gitbutler([branch("empty-top", 0), branch("work", 2), branch("base", 1)]);
    const listed = rows(workspace, true);
    expect(listed.map((row) => [row.branch, row.stack?.position, row.stack?.size])).toEqual([
      ["work", 2, 2],
      ["base", 1, 2],
    ]);
    // A link still resolves the empty branch.
    expect(rows(workspace, false).map((row) => row.branch)).toContain("empty-top");
  });

  test("an empty branch stays listed only while it holds uncommitted work of its own", () => {
    const workspace = gitbutler([branch("fresh", 0)], 1);
    // Unassigned edits belong to no branch.
    expect(rows(workspace, true)).toEqual([]);
    const assigned: WorkspaceValue = {
      ...workspace,
      stacks: [{ ...workspace.stacks[0]!, assigned: [{ path: "a.ts", kind: "modified" }] }],
    };
    expect(rows(assigned, true).map((row) => row.branch)).toEqual(["fresh"]);
    const plain: WorkspaceValue = { ...workspace, provider: "git", checkedOut: "fresh" };
    expect(rows(plain, true).map((row) => row.branch)).toEqual(["fresh"]);
  });
});
