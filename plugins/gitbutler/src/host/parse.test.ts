import { expect, test } from "bun:test";
import {
  branchListPayload,
  diffPayload,
  oplogPayload,
  statusPayload,
} from "../../test/fixtures.ts";
import {
  checkedTarget,
  judgeBranchUpdate,
  namedBranch,
  parseGitLog,
  parseOplog,
  parseParkedBranches,
  parseRefSubjects,
  parseReviews,
  parseWorkspace,
  patchesFor,
  patchesFromGit,
  pullCheck,
  reviewUrl,
  uncommittedKinds,
} from "./parse.ts";

test("parseWorkspace reads stacks, branches, and their commits", () => {
  const workspace = parseWorkspace(statusPayload, "bb-plugins");

  expect(workspace.state).toBe("ready");
  expect(workspace.repoName).toBe("bb-plugins");
  expect(workspace.unassignedChanges).toEqual([
    { path: "bun.lock", kind: "modified" },
    { path: "plugins/gitbutler/LICENSE", kind: "added" },
    // `but status` says `removed` where the rest of the CLI says `deleted`.
    { path: "gone.ts", kind: "deleted" },
  ]);
  expect(workspace.stacks).toHaveLength(2);

  const [first] = workspace.stacks;
  expect(first?.branches.map((branch) => branch.name)).toEqual(["scott/top", "scott/bottom"]);
  expect(first?.assignedChanges).toEqual([{ path: "src/app/app.tsx", kind: "modified" }]);
  expect(first?.branches[0]?.commits[0]).toEqual({
    commitId: "8f4598a1eaca7d3d7080a6756164040f0707d0d5",
    changeId: "syvmzmsvwkuzpwuuxyvnmywkktuzxqul",
    message: "feat(top): add the thing\n\nWith a body.",
    authorName: "Scott Sunarto",
    createdAt: "2026-09-22T21:43:26+00:00",
    conflicted: false,
  });
  expect(first?.branches[0]?.upstreamCommits[0]?.commitId).toBe(
    "1111111111111111111111111111111111111111",
  );
  expect(first?.branches[1]?.commits[0]?.conflicted).toBe(true);
});

test("parseWorkspace keys a stack by its bottom branch, not the CLI id", () => {
  // `but` reassigns cliIds on every invocation, so they cannot key React rows.
  const workspace = parseWorkspace(statusPayload, "bb-plugins");
  expect(workspace.stacks.map((stack) => stack.key)).toEqual([
    "scott/bottom",
    "scott/experimental",
  ]);
});

test("parseWorkspace leads with the most recently committed stack", () => {
  const stackWith = (name: string, ...createdAt: string[]) => ({
    branches: [
      {
        name,
        commits: createdAt.map((time, index) => ({
          commitId: `${name}-${index}`,
          createdAt: time,
        })),
      },
    ],
  });
  const workspace = parseWorkspace(
    {
      stacks: [
        stackWith("scott/empty"),
        stackWith("scott/old", "2026-09-20T10:00:00+00:00"),
        // Offsets differ, so the instant decides, not the string.
        stackWith("scott/new", "2026-09-21T09:00:00+00:00", "2026-09-22T01:00:00-07:00"),
        stackWith("scott/mid", "2026-09-22T07:00:00+00:00"),
      ],
    },
    "repo",
  );
  expect(workspace.stacks.map((stack) => stack.key)).toEqual([
    "scott/new",
    "scott/mid",
    "scott/old",
    "scott/empty",
  ]);
});

test("parseWorkspace maps push status and keeps the raw CLI string", () => {
  const [first, second] = parseWorkspace(statusPayload, "bb-plugins").stacks;
  expect(first?.branches[0]?.status).toBe("pushed");
  expect(first?.branches[1]?.status).toBe("unpushed");
  // An unrecognised status degrades instead of failing the whole panel.
  expect(second?.branches[0]?.status).toBe("unknown");
  expect(second?.branches[0]?.rawStatus).toBe("someFutureStatus");
});

test("parseWorkspace tells a branch that is only ahead from one that diverged", () => {
  const withStatus = (branchStatus: string) =>
    parseWorkspace(
      { stacks: [{ branches: [{ name: "b", branchStatus, commits: [{ commitId: "c1" }] }] }] },
      "repo",
    ).stacks[0]?.branches[0];
  expect(withStatus("unpushedCommits")).toMatchObject({ status: "ahead", push: "push" });
  expect(withStatus("unpushedCommitsRequiringForce")).toMatchObject({
    status: "diverged",
    push: "force",
  });
});

test("parseWorkspace reads the review id without its parentheses, and the CI verdict", () => {
  const [top, bottom] = parseWorkspace(statusPayload, "bb-plugins").stacks[0]!.branches;
  expect(top?.reviewId).toBe("#42");
  expect(top?.ci).toBe("failure");
  expect(bottom?.reviewId).toBeNull();
  expect(bottom?.ci).toBeNull();

  const ci = (value: object) =>
    parseWorkspace({ stacks: [{ branches: [{ name: "b", reviewId: "(!7)", ci: value }] }] }, "r")
      .stacks[0]?.branches[0];
  expect(ci({ status: "inProgress", conclusion: "unknown" })).toMatchObject({
    reviewId: "!7",
    ci: "pending",
  });
  expect(ci({ status: "complete", conclusion: "success" })?.ci).toBe("success");
  // A review with no checks finishes with no verdict, which is no CI to show.
  expect(ci({ status: "complete", conclusion: "unknown" })?.ci).toBeNull();
});

test("parseWorkspace reads the base and upstream state", () => {
  const workspace = parseWorkspace(statusPayload, "bb-plugins");
  expect(workspace.base).toEqual({
    commitId: "654681d034f5e25b7d987f0c8ed8a3c4118a72aa",
    message: "fix: the common base",
    authorName: "Scott Sunarto",
    createdAt: "2026-09-22T20:36:27+00:00",
  });
  expect(workspace.upstream).toEqual({
    behind: 3,
    lastFetched: "2026-09-23T00:08:01.396+00:00",
    latest: {
      commitId: "2222222222222222222222222222222222222222",
      subject: "chore: upstream tip",
    },
  });
});

test("parseWorkspace names the resolved repository, and the upstream tip by its subject only", () => {
  const payload = {
    ...statusPayload,
    upstreamState: {
      behind: 1,
      latestCommit: {
        ...statusPayload.upstreamState.latestCommit,
        message: "feat: one line\n\nThe body the panel does not show.",
      },
    },
  };
  const workspace = parseWorkspace(payload, "bb-plugins", ".");
  expect(workspace.repositoryKey).toBe(".");
  expect(workspace.upstream).toEqual({
    behind: 1,
    lastFetched: null,
    latest: { commitId: "2222222222222222222222222222222222222222", subject: "feat: one line" },
  });
  // A caller that only reads the stacks names no repository.
  expect(parseWorkspace(statusPayload, "bb-plugins").repositoryKey).toBeNull();
});

test("parseWorkspace survives a payload with nothing it expects", () => {
  const workspace = parseWorkspace({ stacks: "not an array" }, "repo");
  expect(workspace.stacks).toEqual([]);
  expect(workspace.base).toBeNull();
  expect(workspace.upstream).toBeNull();
});

test("patchesFor wraps every file's hunks in a git header", () => {
  // Pierre parses a git patch, so the header is what names the file and picks
  // the highlighter. The hunk bodies alone would not parse.
  expect(patchesFor(diffPayload, 10_000)).toEqual({
    files: [
      {
        path: "README.md",
        kind: "modified",
        previousPath: null,
        patch:
          "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n" +
          "@@ -1 +1 @@\n-old\n+new\n@@ -9 +9,2 @@\n tail\n+more\n",
        truncated: false,
      },
      { path: "logo.png", kind: "modified", previousPath: null, patch: "", truncated: false },
    ],
    truncated: false,
  });
});

test("patchesFor marks a file over the CLI's size limit as truncated, not binary", () => {
  const payload = {
    changes: [
      { path: "big.json", status: "modified", diff: { type: "tooLarge", sizeInBytes: 9e7 } },
    ],
  };
  // The change set is short of that file's lines too, so it is marked as well.
  expect(patchesFor(payload, 10_000)).toEqual({
    files: [{ path: "big.json", kind: "modified", previousPath: null, patch: "", truncated: true }],
    truncated: true,
  });
});

test("patchesFor takes uncommitted kinds from `but status`, header included", () => {
  // `but diff` reports every uncommitted file as modified, whatever it is.
  const hunk = (path: string, diff: string) => ({
    path,
    status: "modified",
    diff: { type: "patch", hunks: [{ diff }] },
  });
  const payload = {
    changes: [
      hunk("plugins/gitbutler/LICENSE", "@@ -1,0 +1,1 @@\n+MIT\n"),
      hunk("gone.ts", "@@ -1,1 +1,0 @@\n-export {};\n"),
      hunk("bun.lock", "@@ -1 +1 @@\n-a\n+b\n"),
    ],
  };
  expect(patchesFor(payload, 10_000, uncommittedKinds(statusPayload)).files).toEqual([
    {
      path: "plugins/gitbutler/LICENSE",
      kind: "added",
      previousPath: null,
      patch:
        "diff --git a/plugins/gitbutler/LICENSE b/plugins/gitbutler/LICENSE\n" +
        "new file mode 100644\n--- /dev/null\n+++ b/plugins/gitbutler/LICENSE\n" +
        "@@ -1,0 +1,1 @@\n+MIT\n",
      truncated: false,
    },
    {
      path: "gone.ts",
      kind: "deleted",
      previousPath: null,
      patch:
        "diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\n--- a/gone.ts\n+++ /dev/null\n" +
        "@@ -1,1 +1,0 @@\n-export {};\n",
      truncated: false,
    },
    {
      path: "bun.lock",
      kind: "modified",
      previousPath: null,
      patch:
        "diff --git a/bun.lock b/bun.lock\n--- a/bun.lock\n+++ b/bun.lock\n@@ -1 +1 @@\n-a\n+b\n",
      truncated: false,
    },
  ]);
});

test("patchesFor marks an added file against /dev/null", () => {
  const payload = {
    changes: [
      {
        path: "new.ts",
        status: "added",
        diff: { type: "patch", hunks: [{ diff: "@@ -0,0 +1 @@\n+one\n" }] },
      },
    ],
  };
  expect(patchesFor(payload, 10_000).files[0]?.patch).toBe(
    "diff --git a/new.ts b/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/new.ts\n" +
      "@@ -0,0 +1 @@\n+one\n",
  );
});

test("patchesFor names both sides of a rename", () => {
  const payload = {
    changes: [
      {
        path: "after.ts",
        previousPath: "before.ts",
        status: "renamed",
        diff: { type: "patch", hunks: [{ diff: "@@ -1 +1 @@\n-a\n+b\n" }] },
      },
    ],
  };
  expect(patchesFor(payload, 10_000).files[0]).toEqual({
    path: "after.ts",
    kind: "renamed",
    previousPath: "before.ts",
    patch:
      "diff --git a/before.ts b/after.ts\nrename from before.ts\nrename to after.ts\n" +
      "--- a/before.ts\n+++ b/after.ts\n@@ -1 +1 @@\n-a\n+b\n",
    truncated: false,
  });
});

test("patchesFor truncates on a hunk boundary so the patch still parses", () => {
  // The first hunk fits the budget; the second does not, so it is dropped
  // whole rather than cut in half.
  const [readme] = patchesFor(diffPayload, 25).files;
  expect(readme).toEqual({
    path: "README.md",
    kind: "modified",
    previousPath: null,
    patch:
      "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n" +
      "@@ -1 +1 @@\n-old\n+new\n",
    truncated: true,
  });
});

test("patchesFor folds one file's per-hunk records into a single patch", () => {
  // `but diff` emits a record per hunk, each with its own change id, and not
  // necessarily in file order. The panel shows files, so they fold back.
  const record = (hunk: string) => ({
    path: "src/app.tsx",
    status: "modified",
    diff: { type: "patch", hunks: [{ diff: hunk }] },
  });
  const result = patchesFor(
    {
      changes: [
        record("@@ -378,2 +378,2 @@\n-late\n+later\n"),
        record("@@ -15,2 +15,2 @@\n-early\n+earlier\n"),
      ],
    },
    10_000,
  );
  expect(result.files).toHaveLength(1);
  expect(result.files[0]?.patch).toBe(
    "diff --git a/src/app.tsx b/src/app.tsx\n--- a/src/app.tsx\n+++ b/src/app.tsx\n" +
      "@@ -15,2 +15,2 @@\n-early\n+earlier\n@@ -378,2 +378,2 @@\n-late\n+later\n",
  );
});

test("patchesFor spends one budget across the whole change set", () => {
  // The first file eats the budget, so the second arrives empty rather than
  // pushing a multi-megabyte payload at the browser.
  const hunk = (path: string) => ({
    path,
    status: "modified",
    diff: { type: "patch", hunks: [{ diff: "@@ -1 +1 @@\n-a\n+b\n" }] },
  });
  const result = patchesFor({ changes: [hunk("first.ts"), hunk("second.ts")] }, 20);
  expect(result.files[0]?.patch).toContain("@@ -1 +1 @@");
  expect(result.files[1]).toEqual({
    path: "second.ts",
    kind: "modified",
    previousPath: null,
    patch: "",
    truncated: true,
  });
  expect(result.truncated).toBe(true);
});

test("patchesFromGit reads each file's kind, paths, and hunks from `git show`", () => {
  const output = [
    "diff --git a/scripts/old.sh b/scripts/new.sh",
    "similarity index 100%",
    "rename from scripts/old.sh",
    "rename to scripts/new.sh",
    "diff --git a/gone.ts b/gone.ts",
    "deleted file mode 100644",
    "index 45f83c0..0000000",
    "--- a/gone.ts",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-export {};",
    "diff --git a/logo.png b/logo.png",
    "new file mode 100644",
    "index 0000000..8835708",
    "Binary files /dev/null and b/logo.png differ",
    "diff --git a/with space.md b/with space.md",
    "index 7898192..422c2b7 100644",
    // git ends a path that contains a space with a tab.
    "--- a/with space.md\t",
    "+++ b/with space.md\t",
    "@@ -1 +1,2 @@",
    " a",
    "+b",
    "@@ -9 +10 @@",
    "-c",
    "+d",
    "",
  ].join("\n");
  expect(patchesFromGit(output, 10_000)).toEqual({
    files: [
      {
        path: "scripts/new.sh",
        kind: "renamed",
        previousPath: "scripts/old.sh",
        patch: "",
        truncated: false,
      },
      {
        path: "gone.ts",
        kind: "deleted",
        previousPath: null,
        patch:
          "diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\n--- a/gone.ts\n+++ /dev/null\n" +
          "@@ -1 +0,0 @@\n-export {};\n",
        truncated: false,
      },
      { path: "logo.png", kind: "added", previousPath: null, patch: "", truncated: false },
      {
        path: "with space.md",
        kind: "modified",
        previousPath: null,
        patch:
          "diff --git a/with space.md b/with space.md\n--- a/with space.md\n+++ b/with space.md\n" +
          "@@ -1 +1,2 @@\n a\n+b\n@@ -9 +10 @@\n-c\n+d\n",
        truncated: false,
      },
    ],
    truncated: false,
  });
});

test("reviewUrl reads the first review's address, or none", () => {
  const url = "https://github.com/get-bb/bb/pull/4605";
  expect(reviewUrl({ branch: "b", reviews: [{ number: 4605, url, unitSymbol: "#" }] })).toBe(url);
  expect(reviewUrl({ branch: "b", reviews: [] })).toBeNull();
});

test("parseGitLog reads NUL-terminated fields, an empty subject included", () => {
  // `git log -z` ends every field and every record with a NUL.
  const record = (fields: readonly string[]) => fields.map((field) => `${field}\0`).join("");
  const output =
    record(["abc123", "Ada", "2026-09-22T20:36:27-07:00", "fix: one"]) +
    record(["e0e0e0", "Cy", "2026-09-21T12:00:00-07:00", ""]) +
    record(["def456", "Bo", "2026-09-21T10:00:00-07:00", "feat: two"]);
  expect(parseGitLog(output)).toEqual([
    {
      commitId: "abc123",
      authorName: "Ada",
      createdAt: "2026-09-22T20:36:27-07:00",
      message: "fix: one",
    },
    { commitId: "e0e0e0", authorName: "Cy", createdAt: "2026-09-21T12:00:00-07:00", message: "" },
    {
      commitId: "def456",
      authorName: "Bo",
      createdAt: "2026-09-21T10:00:00-07:00",
      message: "feat: two",
    },
  ]);
});

test("parseGitLog returns nothing for an empty log", () => {
  expect(parseGitLog("")).toEqual([]);
});

test("parseWorkspace lists files left with conflict markers, which status keeps apart", () => {
  const workspace = parseWorkspace({ ...statusPayload, conflictedFiles: ["README.md", 7] }, "x");
  expect(workspace.conflictedFiles).toEqual(["README.md"]);
  expect(parseWorkspace(statusPayload, "x").conflictedFiles).toEqual([]);
});

test("pullCheck reads which branches a workspace pull would leave conflicted", () => {
  // Trimmed from `but pull --check --json` on but 0.22.3.
  const check = {
    baseBranch: { name: "origin/main", remoteName: "origin" },
    upstreamCommits: { count: 5, commits: [] },
    branchStatuses: [
      { name: "feat/ledger-base", status: "conflicted", rebasable: true },
      { name: "feat/ledger-ui", status: "updatable", rebasable: null },
      { name: "fix/parser", status: "integrated", rebasable: null },
    ],
    upToDate: false,
    hasWorktreeConflicts: true,
  };
  expect(pullCheck(check)).toEqual({
    upToDate: false,
    conflicted: ["feat/ledger-base"],
    overlapsUncommitted: true,
  });
  expect(pullCheck({ branchStatuses: [], upToDate: true, hasWorktreeConflicts: false })).toEqual({
    upToDate: true,
    conflicted: [],
    overlapsUncommitted: false,
  });
  // A shape it does not know must not read as "no conflicts".
  expect(() => pullCheck({ status: "ok" })).toThrow("a shape this panel does not know");
});

const sha = (short: string) => short.padEnd(40, "0");

/**
 * `but status -u --json`, reduced to branch names and their commits. Every
 * commit carries the same change id, which must not matter: commits are
 * followed by id.
 */
function statusOf(branches: Record<string, [string, boolean?][]>) {
  return {
    stacks: [
      {
        branches: Object.entries(branches).map(([name, commits]) => ({
          name,
          cliId: name.slice(0, 2),
          branchStatus: "unpushedCommitsRequiringForce",
          commits: commits.map(([id, conflicted = false]) => ({
            cliId: id.slice(0, 3),
            changeId: "samechangeid",
            commitId: sha(id),
            message: id,
            conflicted,
          })),
          upstreamCommits: [],
        })),
      },
    ],
  };
}

/** `but branch update --dry-run --json`, in the shape but 0.22.3 prints it. */
function previewOf(
  segments: Record<string, [string, boolean?][]>,
  replaced: Record<string, string> = {},
) {
  return {
    workspace: {
      replacedCommits: Object.fromEntries(
        Object.entries(replaced).map(([from, to]) => [sha(from), sha(to)]),
      ),
      headInfo: {
        stacks: [
          {
            segments: Object.entries(segments).map(([name, commits]) => ({
              refName: { displayName: name },
              commits: commits.map(([id, hasConflicts = false]) => ({
                id: sha(id),
                changeId: "samechangeid",
                hasConflicts,
                state: { type: "LocalAndRemote" },
              })),
              commitsOnRemote: [],
              pushStatus: "nothingToPush",
            })),
          },
        ],
      },
      checkoutConflictOccurred: false,
    },
  };
}

test("judgeBranchUpdate catches GitButler moving the upper branch's commit into the lower", () => {
  // Observed on but 0.22.3: updating feat/ledger-base took feat/ledger-ui's "ui flag".
  const status = statusOf({
    "feat/ledger-ui": [["391904e3"], ["832a231d"]],
    "feat/ledger-base": [["f58b4e2b"]],
  });
  const preview = previewOf(
    {
      "feat/ledger-ui": [["edd86148"]],
      "feat/ledger-base": [["4b04d100"], ["7f120b4e"], ["f58b4e2b"]],
    },
    { "391904e3": "edd86148", "832a231d": "4b04d100", "015d5dff": "351e3270" },
  );
  expect(judgeBranchUpdate(status, preview)).toEqual({
    moved: [{ from: "feat/ledger-ui", to: "feat/ledger-base" }],
    conflicted: [],
  });
});

test("judgeBranchUpdate passes a pull that only adds the remote's commits", () => {
  const status = statusOf({ "fix/parser": [["1ab8131f"]], other: [["3502e0f4"]] });
  const preview = previewOf({
    "fix/parser": [["34d46efa"], ["d5a1a5b3"], ["1ab8131f"]],
    other: [["3502e0f4"]],
  });
  expect(judgeBranchUpdate(status, preview)).toEqual({ moved: [], conflicted: [] });
});

test("judgeBranchUpdate follows rebased commits, and reports new conflicts, not old ones", () => {
  const status = statusOf({ top: [["0001d", true]], bottom: [["0002e"]] });
  const preview = previewOf(
    { top: [["0003f", true]], bottom: [["0004a"], ["0005b", true]] },
    { "0001d": "0003f", "0002e": "0005b" },
  );
  expect(judgeBranchUpdate(status, preview)).toEqual({ moved: [], conflicted: ["bottom"] });
});

test("judgeBranchUpdate counts a commit the preview drops as moved, and refuses odd shapes", () => {
  // Both commits share a change id, so only their commit ids tell them apart.
  const status = statusOf({ only: [["0001d"], ["0002e"]] });
  expect(judgeBranchUpdate(status, previewOf({ only: [["0001d"]] })).moved).toEqual([
    { from: "only", to: "" },
  ]);
  expect(() => judgeBranchUpdate(status, { workspace: { headInfo: { stacks: [] } } })).toThrow(
    "a shape this panel does not know",
  );
});

test("namedBranch finds the branch, and refuses one whose name is another item's id", () => {
  const status = statusOf({ "scott/top": [["0001d"]], fi: [["0002e"]], "000": [["0003f"]] });
  expect(namedBranch(status, "scott/top").name).toBe("scott/top");
  // Its own id matching its name is no clash.
  expect(namedBranch(status, "fi").name).toBe("fi");
  // `000` is the id of scott/top's commit, so `but` could reword or delete that.
  expect(() => namedBranch(status, "000")).toThrow(
    "GitButler also uses 000 as the id of something else in this workspace",
  );
  expect(() => namedBranch(status, "scott/gone")).toThrow(
    "scott/gone is no longer in the workspace.",
  );
});

test("parseReviews reads each branch's review, applied and parked alike", () => {
  expect(parseReviews(branchListPayload)).toEqual([
    {
      branch: "feat/header-polish",
      number: 140,
      state: "open",
      url: "https://github.com/smsunarto/bb-plugins/pull/140",
    },
    {
      branch: "release-please--branches--main--components--gh-stack",
      number: 135,
      state: "open",
      url: "https://github.com/smsunarto/bb-plugins/pull/135",
    },
  ]);
});

test("parseReviews reads a draft, and skips a review with no usable number", () => {
  const payload = {
    appliedStacks: [{ heads: [{ name: "feat/wip", reviews: [{ number: 7, draft: true }] }] }],
    branches: [
      { name: "feat/odd", reviews: [{ number: "7", url: "https://example.com/7" }] },
      { name: "", reviews: [{ number: 8 }] },
    ],
  };
  expect(parseReviews(payload)).toEqual([
    { branch: "feat/wip", number: 7, state: "draft", url: null },
  ]);
  expect(parseReviews("not json")).toEqual([]);
});

test("parseParkedBranches lists only the branches outside the workspace", () => {
  expect(parseParkedBranches(branchListPayload)).toEqual({
    branches: [
      { name: "scott/monokai-codex-stream", subject: null, updatedAt: "2026-09-30T06:03:46.000Z" },
      {
        name: "release-please--branches--main--components--gh-stack",
        subject: null,
        updatedAt: "2026-09-15T00:50:31.000Z",
      },
    ],
    hasMore: false,
  });
  const payload = {
    appliedStacks: [{ heads: [{ name: "feat/applied" }] }],
    branches: [{ name: "feat/applied" }, { name: "feat/parked", lastCommitAt: "soon" }],
    hasMoreBranches: true,
  };
  expect(parseParkedBranches(payload)).toEqual({
    branches: [{ name: "feat/parked", subject: null, updatedAt: null }],
    hasMore: true,
  });
});

test("parseRefSubjects pairs each NUL-ended name with its subject", () => {
  // git ends each record with a newline, and a commit can have an empty subject.
  const output = "main\0first: on main\0\nfeat/x\0\0\n";
  expect(parseRefSubjects(output)).toEqual(
    new Map([
      ["main", "first: on main"],
      ["feat/x", ""],
    ]),
  );
  expect(parseRefSubjects("")).toEqual(new Map());
});

test("parseOplog reads each operation newest first, with an ISO time", () => {
  expect(parseOplog(oplogPayload)).toEqual([
    {
      id: "22c2d57fb4e93d0fbb45aad16aea1b513b6596d5",
      operation: "SquashCommit",
      title: "SquashCommit",
      body: null,
      createdAt: "2026-10-08T23:19:39.000Z",
    },
    {
      id: "95ff0df18673fdc3ef01df172daa35de0c719031",
      operation: "CreateCommit",
      title: "CreateCommit",
      body: null,
      createdAt: "2026-10-08T23:15:01.000Z",
    },
    {
      id: "d208d31c7e523857c33880daea4241514e0acc3c",
      operation: "MergeUpstream",
      title: "MergeUpstream",
      body: null,
      createdAt: "2026-10-07T00:41:34.000Z",
    },
  ]);
  expect(parseOplog([{ id: "" }, { id: "abc", details: null }, "junk"])).toEqual([
    { id: "abc", operation: "Unknown", title: "Unknown", body: null, createdAt: "" },
  ]);
});

test("checkedTarget reads the target branch the pull check fetched", () => {
  const sha = "a".repeat(40);
  expect(
    checkedTarget({ baseBranch: { name: "origin/main", currentSha: sha }, upToDate: true }),
  ).toEqual({ name: "origin/main", commitId: sha });
  expect(() => checkedTarget({ upToDate: true })).toThrow(
    "GitButler's pull check answered in a shape this panel does not know.",
  );
});
