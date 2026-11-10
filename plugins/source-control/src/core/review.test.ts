import { describe, expect, test } from "vitest";
import type { ChangeKey } from "./ids.ts";
import {
  mergeChanges,
  parseChangeKey,
  parseReviewPath,
  reviewPath,
  startsCollapsed,
  type ChangeRow,
} from "./review.ts";

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
    expect(merged.counts).toEqual({ all: 4, mine: 3, asked: 1 });
  });

  test("shelves by repository, closest to shipping first; a stack keeps bottom last", () => {
    const merged = mergeChanges([host, inbox], "all");
    expect(merged.shelves.map((shelf) => shelf.repo)).toEqual(["acme/api", "smsunarto/bb-plugins"]);
    const shelf = merged.shelves[1]!;
    expect(
      shelf.groups.map((group) => ("rows" in group ? group.rows.map((r) => r.key) : group.key)),
    ).toEqual([C, [A, B]]);
  });

  test("filters keep their counts", () => {
    const asked = mergeChanges([host, inbox], "asked");
    expect(asked.order.map((each) => each.key)).toEqual([X]);
    expect(asked.counts).toEqual({ all: 4, mine: 3, asked: 1 });
  });
});

describe("deep links", () => {
  const K = key("gh:smsunarto/bb-plugins:smsunarto:scott/route-gh");
  // bb encodes each segment of what toPluginPanel is given once more.
  const viaBb = (subPath: string) => subPath.split("/").map(encodeURIComponent).join("/");

  test.each([
    [{ key: K }, { key: K, tab: "files", commit: null, path: null, line: null }],
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
