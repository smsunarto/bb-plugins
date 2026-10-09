import { expect, test } from "bun:test";
import { fakeGh, fixture, fixtureText } from "../../../test/fake-gh.ts";
import type { DiffRevision } from "../../shared/schema.ts";
import { loadChangedFiles, mapChangedFiles } from "./changed-files.ts";

const FILES_PATH = "repos/cli/cli/pulls/9000/files?per_page=100";
const CLI_HEAD = "cc36d32a212a2b8b6611fb73549fe6d04fb6ec38";

/** The `PullRequestHead` answer: only `headRefOid` and `baseRefName` are read here. */
const head = (headRefOid: string, baseRefName = "trunk") => ({
  repository: { pullRequest: { headRefOid, baseRefName } },
});

/** The recorded first page of marks, with the base the query also reads now. */
function recordedMarks() {
  const page = fixture<{ repository: { pullRequest: object } }>("changed-files-cli-9000.json");
  return { repository: { pullRequest: { ...page.repository.pullRequest, baseRefName: "trunk" } } };
}

test("joins recorded REST patches with the viewer's viewed marks by path", async () => {
  const { gh, calls } = fakeGh({
    graphql: {
      ChangedFiles: recordedMarks(),
      PullRequestHead: head(CLI_HEAD),
    },
    rest: { [FILES_PATH]: fixtureText("rest-files-cli-9000.ndjson") },
  });

  const changed = await loadChangedFiles(gh, { owner: "cli", repo: "cli", number: 9000 });

  expect(calls).toEqual([
    {
      kind: "graphql",
      operation: "ChangedFiles",
      variables: { owner: "cli", name: "cli", number: 9000, after: null },
    },
    { kind: "rest", method: "GET", path: FILES_PATH },
    {
      kind: "graphql",
      operation: "PullRequestHead",
      variables: { owner: "cli", name: "cli", number: 9000 },
    },
  ]);
  expect(changed.headRefOid).toBe(CLI_HEAD);
  expect(changed.baseRefName).toBe("trunk");
  expect(changed.files.map(({ patch: _patch, ...file }) => file)).toEqual([
    {
      path: "pkg/cmd/attestation/verify/verify.go",
      previousPath: null,
      status: "modified",
      additions: 1,
      deletions: 0,
      viewed: "unviewed",
    },
    {
      path: "pkg/cmd/attestation/verify/verify_test.go",
      previousPath: null,
      status: "modified",
      additions: 31,
      deletions: 0,
      viewed: "unviewed",
    },
    {
      path: "pkg/cmdutil/auth_check.go",
      previousPath: null,
      status: "modified",
      additions: 27,
      deletions: 2,
      viewed: "unviewed",
    },
    {
      path: "pkg/cmdutil/auth_check_test.go",
      previousPath: null,
      status: "modified",
      additions: 64,
      deletions: 0,
      viewed: "unviewed",
    },
  ]);
  expect(changed.files[0]?.patch).toStartWith(
    "@@ -127,6 +127,7 @@ func NewVerifyCmd(f *cmdutil.Factory, runF func(*Options) error) *cobra.Command\n",
  );
});

test("renames keep their old path, binaries have no patch, and later pages of marks are fetched", async () => {
  const pages: Record<string, unknown> = {
    first: {
      repository: {
        pullRequest: {
          headRefOid: "abc",
          baseRefName: "main",
          files: {
            pageInfo: { hasNextPage: true, endCursor: "p1" },
            nodes: [{ path: "new.ts", viewerViewedState: "VIEWED" }],
          },
        },
      },
    },
    p1: {
      repository: {
        pullRequest: {
          headRefOid: "abc",
          baseRefName: "main",
          files: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{ path: "logo.png", viewerViewedState: "DISMISSED" }],
          },
        },
      },
    },
  };
  const { gh } = fakeGh({
    graphql: {
      ChangedFiles: (variables) => pages[(variables["after"] as string | null) ?? "first"],
      PullRequestHead: head("abc", "main"),
    },
    rest: {
      "repos/o/r/pulls/1/files?per_page=100": [
        {
          filename: "new.ts",
          previous_filename: "old.ts",
          status: "renamed",
          additions: 0,
          deletions: 0,
          patch: "@@ -1 +1 @@\n-a\n+b",
        },
        { filename: "logo.png", status: "added", additions: 0, deletions: 0 },
        {
          filename: "gone.ts",
          status: "removed",
          additions: 0,
          deletions: 3,
          patch: "@@ -1,3 +0,0 @@",
        },
      ],
    },
  });

  const changed = await loadChangedFiles(gh, { owner: "o", repo: "r", number: 1 });

  expect(changed).toEqual({
    headRefOid: "abc",
    baseRefName: "main",
    files: [
      {
        path: "new.ts",
        previousPath: "old.ts",
        status: "renamed",
        additions: 0,
        deletions: 0,
        patch: "@@ -1 +1 @@\n-a\n+b",
        viewed: "viewed",
      },
      {
        path: "logo.png",
        previousPath: null,
        status: "added",
        additions: 0,
        deletions: 0,
        patch: null,
        viewed: "dismissed",
      },
      {
        path: "gone.ts",
        previousPath: null,
        status: "removed",
        additions: 0,
        deletions: 3,
        patch: "@@ -1,3 +0,0 @@",
        viewed: "unviewed",
      },
    ],
  });
});

/**
 * A pull request at `revisions[0]` until its files are read, then at the
 * next one, as if a push or a retarget landed during that read.
 */
function movedDuringRead(revisions: DiffRevision[]) {
  let current = 0;
  const at = () => revisions[current] ?? { headRefOid: "", baseRefName: "" };
  const marks = () => ({
    repository: {
      pullRequest: {
        ...at(),
        files: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
      },
    },
  });
  return fakeGh({
    graphql: {
      ChangedFiles: marks,
      PullRequestHead: () => head(at().headRefOid, at().baseRefName),
    },
    rest: {
      "repos/o/r/pulls/1/files?per_page=100": () => {
        const patch = `@@ at ${at().headRefOid} on ${at().baseRefName} @@`;
        current = Math.min(current + 1, revisions.length - 1);
        return [{ filename: "a.ts", status: "modified", additions: 1, deletions: 0, patch }];
      },
    },
  });
}

/** Pushes during the read, on one base. */
const pushedDuringRead = (heads: string[]) =>
  movedDuringRead(heads.map((headRefOid) => ({ headRefOid, baseRefName: "main" })));

test("a push between reads loads again, and patches carry the head they were read at", async () => {
  const { gh, operations } = pushedDuringRead(["old", "new"]);

  const changed = await loadChangedFiles(gh, { owner: "o", repo: "r", number: 1 });

  expect(changed).toEqual({
    headRefOid: "new",
    baseRefName: "main",
    files: [
      {
        path: "a.ts",
        previousPath: null,
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: "@@ at new on main @@",
        viewed: "unviewed",
      },
    ],
  });
  expect(operations()).toEqual([
    "ChangedFiles",
    "PullRequestHead",
    "ChangedFiles",
    "PullRequestHead",
  ]);
});

test("a retarget between reads loads again, and patches carry the base they compare against", async () => {
  const { gh, operations } = movedDuringRead([
    { headRefOid: "abc", baseRefName: "main" },
    { headRefOid: "abc", baseRefName: "release" },
  ]);

  const changed = await loadChangedFiles(gh, { owner: "o", repo: "r", number: 1 });

  expect(changed).toEqual({
    headRefOid: "abc",
    baseRefName: "release",
    files: [
      {
        path: "a.ts",
        previousPath: null,
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: "@@ at abc on release @@",
        viewed: "unviewed",
      },
    ],
  });
  expect(operations()).toEqual([
    "ChangedFiles",
    "PullRequestHead",
    "ChangedFiles",
    "PullRequestHead",
  ]);
});

test("a head that keeps moving fails after three loads", async () => {
  const { gh, operations } = pushedDuringRead(["a", "b", "c", "d"]);

  await expect(loadChangedFiles(gh, { owner: "o", repo: "r", number: 1 })).rejects.toThrow(
    "The pull request kept changing while its files loaded. Try again.",
  );
  expect(operations().filter((operation) => operation === "ChangedFiles")).toHaveLength(3);
});

test("an unknown file status reads as changed", () => {
  const changed = mapChangedFiles(
    { headRefOid: "abc", baseRefName: "main" },
    [{ filename: "a", status: "typechange", additions: 0, deletions: 0 }],
    [],
  );
  expect(changed.files[0]?.status).toBe("changed");
});
