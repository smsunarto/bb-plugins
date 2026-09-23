import { expect, test } from "bun:test";
import { harness } from "../../../test/harness.ts";
import { patch } from "./patch.ts";

const uncommitted = { threadId: "t1", source: { kind: "uncommitted" } as const, path: "README.md" };

test("forwards the patch source and path to the host entry", async () => {
  const result = { path: "README.md", patch: "@@ -1 +1 @@\n-a\n+b\n", truncated: false };
  const { ctx, calls } = harness({ result });

  expect(await patch.execute(ctx, uncommitted)).toEqual(result);
  expect(calls[0]?.input).toEqual({
    environmentPath: "/work",
    source: { kind: "uncommitted" },
    path: "README.md",
  });
});

test("fails loudly when the thread has no environment", async () => {
  const { ctx } = harness({ environment: null });

  expect(patch.execute(ctx, uncommitted)).rejects.toThrow(
    "This thread has no project environment.",
  );
});
