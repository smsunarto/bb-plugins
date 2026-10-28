import { expect, test } from "bun:test";
import { fakeGh, fixture, fixtureText } from "../../../test/fake-gh.ts";
import type { DiffRevision } from "../../shared/schema.ts";
import { loadChangedFiles, mapChangedFiles } from "./changed-files.ts";
import { createGh } from "./gh.ts";

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
      generated: false,
    },
    {
      path: "pkg/cmd/attestation/verify/verify_test.go",
      previousPath: null,
      status: "modified",
      additions: 31,
      deletions: 0,
      viewed: "unviewed",
      generated: false,
    },
    {
      path: "pkg/cmdutil/auth_check.go",
      previousPath: null,
      status: "modified",
      additions: 27,
      deletions: 2,
      viewed: "unviewed",
      generated: false,
    },
    {
      path: "pkg/cmdutil/auth_check_test.go",
      previousPath: null,
      status: "modified",
      additions: 64,
      deletions: 0,
      viewed: "unviewed",
      generated: false,
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
    comparison: null,
    files: [
      {
        path: "new.ts",
        previousPath: "old.ts",
        status: "renamed",
        additions: 0,
        deletions: 0,
        patch: "@@ -1 +1 @@\n-a\n+b",
        viewed: "viewed",
        generated: false,
      },
      {
        path: "logo.png",
        previousPath: null,
        status: "added",
        additions: 0,
        deletions: 0,
        patch: null,
        viewed: "dismissed",
        generated: false,
      },
      {
        path: "gone.ts",
        previousPath: null,
        status: "removed",
        additions: 0,
        deletions: 3,
        patch: "@@ -1,3 +0,0 @@",
        viewed: "unviewed",
        generated: false,
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
    comparison: null,
    files: [
      {
        path: "a.ts",
        previousPath: null,
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: "@@ at new on main @@",
        viewed: "unviewed",
        generated: false,
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
    comparison: null,
    files: [
      {
        path: "a.ts",
        previousPath: null,
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: "@@ at abc on release @@",
        viewed: "unviewed",
        generated: false,
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

test("files the head's .gitattributes marks linguist-generated read as generated", async () => {
  const marks = recordedMarks();
  const attributes = "pkg/cmdutil/*_test.go linguist-generated\n";
  const { gh } = fakeGh({
    graphql: {
      ChangedFiles: {
        repository: {
          pullRequest: {
            ...marks.repository.pullRequest,
            commits: { nodes: [{ commit: { file: { object: { text: attributes } } } }] },
          },
        },
      },
      PullRequestHead: head(CLI_HEAD),
    },
    rest: { [FILES_PATH]: fixtureText("rest-files-cli-9000.ndjson") },
  });

  const changed = await loadChangedFiles(gh, { owner: "cli", repo: "cli", number: 9000 });

  expect(changed.files.filter((file) => file.generated).map((file) => file.path)).toEqual([
    "pkg/cmdutil/auth_check_test.go",
  ]);
});

const attributesPath = ["repository", "pullRequest", "commits", "nodes", 0, "commit", "file"];

/** GitHub returns the file list alongside a NOT_FOUND error when .gitattributes is absent. */
function missingAttributesGh(
  errors: { type: string; path?: readonly (string | number)[] }[],
  nullAt?: "repository" | "pullRequest" | "commits",
) {
  let pages = 0;
  const gh = createGh(async (args, stdin) => {
    if (args[1] !== "graphql") {
      return { code: 0, stdout: fixtureText("rest-files-cli-9000.ndjson"), stderr: "" };
    }
    const { query } = JSON.parse(stdin ?? "{}");
    if (!query.includes("query ChangedFiles(")) {
      return { code: 0, stdout: JSON.stringify({ data: head(CLI_HEAD) }), stderr: "" };
    }
    pages++;
    const recorded = fixture<{
      repository: {
        pullRequest: { files: { nodes: { path: string; viewerViewedState: string }[] } };
      };
    }>("changed-files-cli-9000.json");
    const nodes = recorded.repository.pullRequest.files.nodes;
    for (const node of nodes.slice(3)) node.viewerViewedState = "VIEWED";
    const data = {
      repository:
        nullAt === "repository"
          ? null
          : {
              pullRequest:
                nullAt === "pullRequest"
                  ? null
                  : {
                      ...recordedMarks().repository.pullRequest,
                      commits:
                        nullAt === "commits" ? null : { nodes: [{ commit: { file: null } }] },
                      files: {
                        pageInfo: {
                          hasNextPage: pages === 1,
                          endCursor: pages === 1 ? "next" : null,
                        },
                        nodes: pages === 1 ? nodes.slice(0, 2) : nodes.slice(2),
                      },
                    },
            },
    };
    return { code: 1, stdout: JSON.stringify({ data, errors }), stderr: "" };
  });
  return { gh, pages: () => pages };
}

test("a missing .gitattributes still loads every page of patches and viewed marks", async () => {
  const { gh, pages } = missingAttributesGh([{ type: "NOT_FOUND", path: attributesPath }]);

  const changed = await loadChangedFiles(gh, { owner: "cli", repo: "cli", number: 9000 });

  expect(pages()).toBe(2);
  expect(changed.files).toHaveLength(4);
  expect(changed.files.every((file) => file.patch && !file.generated)).toBe(true);
  expect(changed.files.map((file) => file.viewed)).toEqual([
    "unviewed",
    "unviewed",
    "unviewed",
    "viewed",
  ]);
});

test.each([
  { type: "FORBIDDEN", path: attributesPath, code: "forbidden" },
  { type: "RATE_LIMITED", code: "rate-limited" },
])("a missing .gitattributes does not hide another $code failure", async ({ code, ...error }) => {
  const { gh } = missingAttributesGh([{ type: "NOT_FOUND", path: attributesPath }, error]);

  await expect(
    loadChangedFiles(gh, { owner: "cli", repo: "cli", number: 9000 }),
  ).rejects.toMatchObject({ code });
});

test.each(["repository", "pullRequest", "commits"] as const)(
  "a missing .gitattributes cannot excuse a null %s ancestor",
  async (nullAt) => {
    const { gh } = missingAttributesGh([{ type: "NOT_FOUND", path: attributesPath }], nullAt);
    await expect(
      loadChangedFiles(gh, { owner: "cli", repo: "cli", number: 9000 }),
    ).rejects.toMatchObject({ code: "not-found" });
  },
);

test("a NOT_FOUND at a different leaf is not treated as a missing .gitattributes", async () => {
  const { gh } = missingAttributesGh([{ type: "NOT_FOUND", path: [...attributesPath, "object"] }]);
  await expect(
    loadChangedFiles(gh, { owner: "cli", repo: "cli", number: 9000 }),
  ).rejects.toMatchObject({ code: "not-found" });
});

test("the files name both commits a preview reads, pinned in the same read as the patches", async () => {
  const base = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  const page = recordedMarks();
  const { gh } = fakeGh({
    graphql: {
      ChangedFiles: {
        repository: {
          pullRequest: {
            ...page.repository.pullRequest,
            baseRefOid: base,
            headRepository: { nameWithOwner: "fork/cli" },
          },
        },
      },
      PullRequestHead: head(CLI_HEAD),
    },
    rest: { [FILES_PATH]: fixtureText("rest-files-cli-9000.ndjson") },
  });

  const changed = await loadChangedFiles(
    gh,
    { owner: "cli", repo: "cli", number: 9000 },
    "octocat",
  );

  expect(changed.comparison).toEqual({
    kind: "github",
    account: "octocat",
    owner: "cli",
    repo: "cli",
    headRepository: "fork/cli",
    base,
    head: CLI_HEAD,
  });
});
