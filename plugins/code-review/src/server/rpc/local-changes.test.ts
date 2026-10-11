import { expect, test } from "bun:test";
import { callProcedure } from "@bb-kit/core/rpc";
import { fakeContext } from "../../../test/fake-gh.ts";
import { BOTTOM, TOP, fakeGitButler } from "../../../test/fake-gitbutler.ts";
import { localChanges } from "./local-changes.ts";

const RANGE = { hostId: "host-1", path: "/home/scott/git/api", base: BOTTOM, head: TOP };

test("a branch's changes are read from its machine, labeled by its range", async () => {
  const asked: unknown[] = [];
  const { ctx } = fakeContext(
    {},
    {
      plugins: fakeGitButler({
        branchPatches: (input) => {
          asked.push(input);
          return {
            truncated: false,
            files: [
              {
                path: "a.ts",
                kind: "added",
                previousPath: null,
                patch:
                  "diff --git a/a.ts b/a.ts\nnew file mode 100644\n--- /dev/null\n+++ b/a.ts\n@@ -0,0 +1 @@\n+a\n",
                truncated: false,
              },
            ],
          };
        },
      }),
    },
  );

  expect(await callProcedure(localChanges, ctx, RANGE)).toEqual({
    headRefOid: TOP,
    baseRefName: BOTTOM,
    files: [
      {
        path: "a.ts",
        previousPath: null,
        status: "added",
        additions: 1,
        deletions: 0,
        patch: "@@ -0,0 +1 @@\n+a",
        viewed: "unviewed",
        generated: false,
      },
    ],
  });
  expect(asked).toEqual([RANGE]);
});

test("a range end that is not a commit id is refused before anything runs", async () => {
  const { ctx } = fakeContext({}, { plugins: fakeGitButler({}) });

  await expect(
    callProcedure(localChanges, ctx, { ...RANGE, head: "--output=/tmp/x" }),
  ).rejects.toThrow("invalid input");
});
