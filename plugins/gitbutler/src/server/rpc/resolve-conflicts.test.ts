import { expect, test } from "bun:test";
import { reviewContext as context } from "../../../test/review-stub.ts";
import { resolveConflicts } from "./resolve-conflicts.ts";

test("spawns a visible child on the same environment, pointed at the repository path", async () => {
  const { ctx, spawned } = context();

  expect(await resolveConflicts.execute(ctx, { threadId: "t1" })).toEqual({ threadId: "child-1" });
  expect(spawned[0]).toMatchObject({
    projectId: "p1",
    environment: { type: "reuse", environmentId: "env-1" },
    providerId: "claude-code",
    parentThreadId: "t1",
    title: "Resolve conflicts in api",
  });
  // No key means the panel's default repository, and the child gets its path.
  expect(spawned[0]!["prompt"]).toContain("cd '/work/repos/api'\nbut status");
});

test("one subthread per repository: asking again returns it, and resumes it once stopped", async () => {
  const { ctx, spawned, sent, children } = context();
  await resolveConflicts.execute(ctx, { threadId: "t1" });

  expect(await resolveConflicts.execute(ctx, { threadId: "t1" })).toEqual({ threadId: "child-1" });
  // So does another thread whose panel shows the same workspace.
  expect(await resolveConflicts.execute(ctx, { threadId: "t2" })).toEqual({ threadId: "child-1" });
  expect(sent).toHaveLength(0);
  // Another repository's conflicts are another job.
  await resolveConflicts.execute(ctx, { threadId: "t1", repositoryKey: "." });
  expect(spawned).toHaveLength(2);

  // Stopped, perhaps to ask the user something: it gets the job again, and
  // no second resolver starts.
  children.set("child-1", { status: "idle", archivedAt: null });
  expect(await resolveConflicts.execute(ctx, { threadId: "t1" })).toEqual({ threadId: "child-1" });
  expect(sent).toEqual([
    {
      threadId: "child-1",
      mode: "queue-if-active",
      input: [{ type: "text", text: spawned[0]!["prompt"], mentions: [] }],
    },
  ]);
  expect(spawned).toHaveLength(2);

  // Archived, it is gone, and the next request starts a fresh one.
  children.set("child-1", { status: "idle", archivedAt: 1 });
  expect(await resolveConflicts.execute(ctx, { threadId: "t1" })).toEqual({ threadId: "child-3" });
  // And the fresh one is the repository's from then on.
  expect(await resolveConflicts.execute(ctx, { threadId: "t2" })).toEqual({ threadId: "child-3" });
  expect(spawned).toHaveLength(3);
});

test("requests that overlap still start one subthread between them", async () => {
  const { ctx, spawned } = context();

  const answers = await Promise.all([
    resolveConflicts.execute(ctx, { threadId: "t1" }),
    resolveConflicts.execute(ctx, { threadId: "t2" }),
    resolveConflicts.execute(ctx, { threadId: "t1", repositoryKey: "." }),
  ]);
  expect(answers).toEqual([
    { threadId: "child-1" },
    { threadId: "child-1" },
    { threadId: "child-2" },
  ]);
  expect(spawned.map((args) => args["title"])).toEqual([
    "Resolve conflicts in api",
    "Resolve conflicts in work",
  ]);
});

test("a lookup that fails for another reason than a deleted thread starts nothing", async () => {
  const { ctx, spawned, sent, children, lookupFailures } = context();
  await resolveConflicts.execute(ctx, { threadId: "t1" });
  lookupFailures.set("child-1", 503);
  await expect(resolveConflicts.execute(ctx, { threadId: "t1" })).rejects.toThrow("HTTP 503");
  expect(spawned).toHaveLength(1);
  expect(sent).toHaveLength(0);
  // Once bb answers again, the same subthread is still the repository's.
  lookupFailures.delete("child-1");
  expect(await resolveConflicts.execute(ctx, { threadId: "t1" })).toEqual({ threadId: "child-1" });
  // Deleted, it is gone, and the next request starts a fresh one.
  children.delete("child-1");
  expect(await resolveConflicts.execute(ctx, { threadId: "t1" })).toEqual({ threadId: "child-2" });
});

test("a resolver still finishing its turn after an archive, or with work queued, is still the one", async () => {
  const { ctx, spawned, sent, children } = context();
  await resolveConflicts.execute(ctx, { threadId: "t1" });

  // bb lets an archived turn run on while the archive can be undone.
  children.set("child-1", { status: "active", archivedAt: 1 });
  expect(await resolveConflicts.execute(ctx, { threadId: "t1" })).toEqual({ threadId: "child-1" });
  // A resume that bb queued has not started yet, but it will.
  children.set("child-1", { status: "idle", archivedAt: null, queuedMessageCount: 1 });
  expect(await resolveConflicts.execute(ctx, { threadId: "t1" })).toEqual({ threadId: "child-1" });
  expect(spawned).toHaveLength(1);
  expect(sent).toHaveLength(0);
});

test("spawns nothing for a thread without an environment", async () => {
  const { ctx, spawned, hostInputs } = context({ environment: null });
  await expect(resolveConflicts.execute(ctx, { threadId: "t1" })).rejects.toThrow(
    "This thread has no project environment.",
  );
  expect(spawned).toHaveLength(0);
  expect(hostInputs).toHaveLength(0);
});
