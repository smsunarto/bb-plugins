import { expect, test } from "bun:test";
import { reviewContext as context } from "../../../test/review-stub.ts";
import { conflictResolution } from "./conflict-resolution.ts";
import { resolveConflicts } from "./resolve-conflicts.ts";

test("finds the repository's subthread, says when it stopped, and drops it once archived", async () => {
  const { ctx, children } = context();
  expect(await conflictResolution.execute(ctx, { threadId: "t1" })).toEqual({ subthread: null });

  await resolveConflicts.execute(ctx, { threadId: "t1" });
  await resolveConflicts.execute(ctx, { threadId: "t1", repositoryKey: "." });
  expect(await conflictResolution.execute(ctx, { threadId: "t1" })).toEqual({
    subthread: { threadId: "child-1", running: true },
  });
  // Another thread on the same workspace sees the same subthread.
  expect(await conflictResolution.execute(ctx, { threadId: "t2" })).toEqual({
    subthread: { threadId: "child-1", running: true },
  });

  children.set("child-1", { status: "idle", archivedAt: null });
  expect(await conflictResolution.execute(ctx, { threadId: "t1" })).toEqual({
    subthread: { threadId: "child-1", running: false },
  });

  children.set("child-1", { status: "idle", archivedAt: 1 });
  expect(await conflictResolution.execute(ctx, { threadId: "t1" })).toEqual({ subthread: null });
  // The other repository keeps its own.
  expect(await conflictResolution.execute(ctx, { threadId: "t1", repositoryKey: "." })).toEqual({
    subthread: { threadId: "child-2", running: true },
  });
});
