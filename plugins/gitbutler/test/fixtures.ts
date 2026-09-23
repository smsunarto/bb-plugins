/**
 * A `but status -u --json` payload, shaped from real CLI output and trimmed
 * to the cases the parser has to get right: an untracked file, a two-branch
 * stack, assigned changes, an upstream commit, a conflicted commit, and a
 * `branchStatus` the plugin does not know.
 */
export const statusPayload = {
  uncommittedChanges: [
    { cliId: "uz", filePath: "bun.lock", changeType: "modified" },
    { cliId: "ot", filePath: "plugins/gitbutler/LICENSE", changeType: "added" },
  ],
  stacks: [
    {
      cliId: "g0",
      assignedChanges: [{ cliId: "aa", filePath: "src/app/app.tsx", changeType: "modified" }],
      branches: [
        {
          cliId: "sc",
          name: "scott/top",
          commits: [
            {
              cliId: "syv",
              changeId: "syvmzmsvwkuzpwuuxyvnmywkktuzxqul",
              commitId: "8f4598a1eaca7d3d7080a6756164040f0707d0d5",
              createdAt: "2026-09-22T21:43:26+00:00",
              message: "feat(top): add the thing\n\nWith a body.",
              authorName: "Scott Sunarto",
              authorEmail: "github@smsunarto.com",
              conflicted: false,
              reviewId: "42",
              changes: null,
            },
          ],
          upstreamCommits: [
            {
              cliId: "u1",
              changeId: null,
              commitId: "1111111111111111111111111111111111111111",
              createdAt: "2026-09-22T10:00:00+00:00",
              message: "chore: someone else's push",
              authorName: "Other Person",
              authorEmail: "other@example.com",
              conflicted: false,
              reviewId: null,
              changes: null,
            },
          ],
          branchStatus: "nothingToPush",
          reviewId: "42",
          ci: { status: "success" },
        },
        {
          cliId: "cb",
          name: "scott/bottom",
          commits: [
            {
              cliId: "snq",
              changeId: "snqmwnttkmzkolqmslkulyqmmmqumpuy",
              commitId: "730b2a16bda1bd8bdc4572bd9f4df70f50505f90",
              createdAt: "2026-09-22T21:23:13+00:00",
              message: "fix(bottom): repair it",
              authorName: "Scott Sunarto",
              authorEmail: "github@smsunarto.com",
              conflicted: true,
              reviewId: null,
              changes: null,
            },
          ],
          upstreamCommits: [],
          branchStatus: "completelyUnpushed",
          reviewId: null,
          ci: null,
        },
      ],
    },
    {
      cliId: "h0",
      assignedChanges: [],
      branches: [
        {
          cliId: "zz",
          name: "scott/experimental",
          commits: [],
          upstreamCommits: [],
          branchStatus: "someFutureStatus",
          reviewId: null,
          ci: null,
        },
      ],
    },
  ],
  mergeBase: {
    cliId: "",
    commitId: "654681d034f5e25b7d987f0c8ed8a3c4118a72aa",
    createdAt: "2026-09-22T20:36:27+00:00",
    message: "fix: the common base",
    authorName: "Scott Sunarto",
    authorEmail: "github@smsunarto.com",
    conflicted: null,
    reviewId: null,
    changes: null,
  },
  upstreamState: {
    behind: 3,
    latestCommit: {
      cliId: "",
      commitId: "2222222222222222222222222222222222222222",
      createdAt: "2026-09-22T22:00:00+00:00",
      message: "chore: upstream tip",
      authorName: "Other Person",
      authorEmail: "other@example.com",
      conflicted: null,
      reviewId: null,
      changes: null,
    },
    lastFetched: "2026-09-23T00:08:01.396+00:00",
  },
};

/** `but diff <commit> --json`, with one text file and one binary file. */
export const diffPayload = {
  changes: [
    {
      path: "README.md",
      status: "modified",
      diff: {
        type: "patch",
        hunks: [
          { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, diff: "@@ -1 +1 @@\n-old\n+new\n" },
          { oldStart: 9, oldLines: 1, newStart: 9, newLines: 2, diff: "@@ -9 +9,2 @@\n tail\n+more\n" },
        ],
      },
    },
    { path: "logo.png", status: "modified", diff: { type: "binary" } },
  ],
};

/** `but show <commit> --json`. */
export const showPayload = {
  commit: "8f4598a1eaca7d3d7080a6756164040f0707d0d5",
  author: { name: "Scott Sunarto", email: "github@smsunarto.com" },
  committer: { name: "Scott Sunarto", email: "github@smsunarto.com" },
  date: "2026-09-22 14:43:26 -0700",
  message: "feat(top): add the thing\n\nWith a body.",
  files: [
    { path: "src/app/app.tsx", status: "modified" },
    { path: "src/app/new.tsx", status: "added" },
  ],
  changeId: "syvmzmsvwkuzpwuuxyvnmywkktuzxqul",
};
