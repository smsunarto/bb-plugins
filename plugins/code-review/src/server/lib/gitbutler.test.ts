import { expect, test } from "bun:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { BASE, BOTTOM, TOP, UNPUBLISHED, fakeGitButler } from "../../../test/fake-gitbutler.ts";
import { hunks, loadLocalBranches, loadLocalChanges, requireLocalBranch } from "./gitbutler.ts";

function host(plugins: ReturnType<typeof fakeGitButler>) {
  return createFakePluginHost({ pluginId: "code-review", sdk: { plugins } }).bb;
}

test("unpublished branches are read from the GitButler plugin, newest commit first", async () => {
  const bb = host(fakeGitButler({ unpublishedBranches: () => UNPUBLISHED }));

  expect(await loadLocalBranches(bb)).toEqual({
    available: true,
    branches: [
      {
        id: "f4b6d5b36a16",
        hostId: "host-1",
        machine: "builder",
        path: "/home/example/git/api",
        repoName: "api",
        repository: "acme/api",
        branch: "scott/rate-limit",
        status: "ahead",
        head: TOP,
        base: BOTTOM,
        parent: "scott/login-copy",
        commits: [
          {
            commitId: TOP,
            message: "Rate-limit the login endpoint",
            authorName: "Scott",
            createdAt: "2026-10-10T09:00:00Z",
          },
        ],
      },
      {
        id: "012abaff5bd7",
        hostId: "host-1",
        machine: "builder",
        path: "/home/example/git/api",
        repoName: "api",
        repository: "acme/api",
        branch: "scott/login-copy",
        status: "unpushed",
        head: BOTTOM,
        base: BASE,
        parent: null,
        commits: [
          {
            commitId: BOTTOM,
            message: "Reword the login error\n\nSays which field is wrong.",
            authorName: "Scott",
            createdAt: "2026-10-09T10:00:00Z",
          },
        ],
      },
      {
        id: "bddb4c3d89da",
        hostId: "host-2",
        machine: "laptop",
        path: "/Users/example/web",
        repoName: "web",
        repository: null,
        branch: "fix-nav",
        status: "unpushed",
        head: TOP,
        base: BASE,
        parent: null,
        commits: [
          {
            commitId: TOP,
            message: "Fix the nav",
            authorName: "Ada",
            createdAt: "2026-10-01T00:00:00Z",
          },
        ],
      },
    ],
  });
});

test("without the GitButler plugin there are no branches to read, and the reader is told why", async () => {
  const bb = host(fakeGitButler({}, { installed: false }));

  expect(await loadLocalBranches(bb)).toEqual({
    available: false,
    reason:
      "Install and enable the GitButler plugin to review branches that have no pull request yet.",
  });
  await expect(requireLocalBranch(bb, "f4b6d5b36a16")).rejects.toThrow(
    "Install and enable the GitButler plugin",
  );
});

test("a GitButler plugin that fails says so instead of reading as not installed", async () => {
  const bb = host(
    fakeGitButler({
      unpublishedBranches: () => {
        throw new Error("but status timed out");
      },
    }),
  );

  await expect(loadLocalBranches(bb)).rejects.toThrow("but status timed out");
});

test("a branch that was published or is gone cannot be found by its id", async () => {
  const bb = host(fakeGitButler({ unpublishedBranches: () => UNPUBLISHED }));

  expect((await requireLocalBranch(bb, "012abaff5bd7")).branch).toBe("scott/login-copy");
  await expect(requireLocalBranch(bb, "000000000000")).rejects.toThrow(
    "That branch has no unpublished commits any more, or its machine is offline.",
  );
});

test("a branch's patches become changed files: hunks only, counted, and labeled by range", async () => {
  const inputs: unknown[] = [];
  const bb = host(
    fakeGitButler({
      branchPatches: (input) => {
        inputs.push(input);
        return {
          truncated: false,
          files: [
            {
              path: "src/login.ts",
              kind: "modified",
              previousPath: null,
              patch: [
                "diff --git a/src/login.ts b/src/login.ts",
                "index 1111111..2222222 100644",
                "--- a/src/login.ts",
                "+++ b/src/login.ts",
                "@@ -1,2 +1,3 @@",
                " import { limit } from './limit';",
                "-login();",
                "+limit(login)();",
                "+// ---",
                "",
              ].join("\n"),
              truncated: false,
            },
            {
              path: "old.ts",
              kind: "deleted",
              previousPath: null,
              patch:
                "diff --git a/old.ts b/old.ts\ndeleted file mode 100644\n--- a/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n",
              truncated: false,
            },
            {
              path: "logo.png",
              kind: "added",
              previousPath: null,
              patch:
                "diff --git a/logo.png b/logo.png\nnew file mode 100644\nBinary files /dev/null and b/logo.png differ\n",
              truncated: false,
            },
            {
              path: "bun.lock",
              kind: "renamed",
              previousPath: "bun.lockb",
              patch: "diff --git a/bun.lockb b/bun.lock\n@@ -1 +1 @@\n-a\n+b\n",
              truncated: true,
            },
          ],
        };
      },
    }),
  );
  const range = { hostId: "host-1", path: "/home/example/git/api", base: BOTTOM, head: TOP };

  expect(await loadLocalChanges(bb, range)).toEqual({
    headRefOid: TOP,
    baseRefName: BOTTOM,
    files: [
      {
        path: "src/login.ts",
        previousPath: null,
        status: "modified",
        additions: 2,
        deletions: 1,
        patch:
          "@@ -1,2 +1,3 @@\n import { limit } from './limit';\n-login();\n+limit(login)();\n+// ---",
        viewed: "unviewed",
        generated: false,
      },
      {
        path: "old.ts",
        previousPath: null,
        status: "removed",
        additions: 0,
        deletions: 1,
        patch: "@@ -1 +0,0 @@\n-gone",
        viewed: "unviewed",
        generated: false,
      },
      {
        path: "logo.png",
        previousPath: null,
        status: "added",
        additions: 0,
        deletions: 0,
        patch: null,
        viewed: "unviewed",
        generated: false,
      },
      {
        path: "bun.lock",
        previousPath: "bun.lockb",
        status: "renamed",
        additions: 0,
        deletions: 0,
        patch: null,
        viewed: "unviewed",
        generated: true,
      },
    ],
  });
  expect(inputs).toEqual([range]);
});

test("hunks drop the file header and keep everything from the first hunk on", () => {
  expect(hunks("@@ -1 +1 @@\n-a\n+b\n")).toBe("@@ -1 +1 @@\n-a\n+b");
  expect(hunks("diff --git a/x b/x\nold mode 100644\nnew mode 100755\n")).toBeNull();
  expect(hunks("")).toBeNull();
});
