import { expect, test } from "bun:test";
import { harness } from "../../../test/harness.ts";
import { patches } from "./patches.ts";

const uncommitted = { threadId: "t1", source: { kind: "uncommitted" } as const };

test("forwards the patch source to the host entry", async () => {
  const result = {
    files: [
      {
        path: "README.md",
        kind: "modified" as const,
        patch:
          "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-a\n+b\n",
        truncated: false,
      },
    ],
    truncated: false,
  };
  const { ctx, calls } = harness({ result });

  expect(await patches.execute(ctx, uncommitted)).toEqual(result);
  expect(calls[0]?.input).toEqual({
    environmentPath: "/work",
    source: { kind: "uncommitted" },
  });
});

test("fails loudly when the thread has no environment", async () => {
  const { ctx } = harness({ environment: null });

  expect(patches.execute(ctx, uncommitted)).rejects.toThrow(
    "This thread has no project environment.",
  );
});
