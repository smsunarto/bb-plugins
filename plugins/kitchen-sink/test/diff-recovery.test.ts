import { describe, expect, mock, test } from "bun:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { loadDiffEmbed } from "../src/server/lib/load-diff-embed.ts";
import { splitPatchFiles } from "../src/server/lib/patch-file.ts";
import { rangePatch } from "../src/server/lib/diff-range.ts";
import { snapshotDatabase, diffSnapshotMigrations } from "../src/server/lib/diff-snapshot.ts";

const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
const input = {
  kind: "diff" as const,
  threadId: "t",
  messageId: "m",
  turnId: "turn",
  path: "a.ts",
};
function setup() {
  const { bb: base } = createFakePluginHost({ pluginId: "kitchen-sink" });
  const events = mock(async (_args: unknown) => [
    {
      type: "turn/diff/updated",
      scope: { kind: "turn", turnId: "turn" },
      seq: 2,
      data: { diff: patch },
    },
  ]);
  const diff = mock(async (_args: unknown) => ({
    outcome: "available",
    diff: { diff: patch, truncated: false },
  }));
  const read = mock(async (_args: unknown) => ({ content: patch, contentEncoding: "utf8" }));
  const getEnvironment = mock(
    async (): Promise<{ mergeBaseBranch: string | null; defaultBranch: string | null }> => ({
      mergeBaseBranch: "origin/main",
      defaultBranch: "main",
    }),
  );
  const status = mock(async () => ({
    outcome: "available",
    workspace: { mergeBase: null, branch: { defaultBranch: "trunk" } },
  }));
  const bb = {
    ...base,
    sdk: {
      ...base.sdk,
      threads: {
        ...base.sdk.threads,
        events: { list: events },
        get: async () => ({ environmentId: "e" }),
        storageLocation: async () => ({ hostId: "h", storageRootPath: "/storage/t" }),
      },
      environments: { get: getEnvironment, diff, status },
      files: { read },
    },
  } as unknown as BbPluginApi;
  return { bb, events, diff, read, getEnvironment, status };
}
describe("historical evidence", () => {
  test("first display after commit or shipping reads exact persisted turn, not Git", async () => {
    const { bb, diff } = setup();
    expect(await loadDiffEmbed(bb, input)).toMatchObject({
      status: "ready",
      patch,
      source: "Recorded turn: turn",
    });
    expect(diff).not.toHaveBeenCalled();
  });
  test("snapshot survives later changes and a fresh loader call", async () => {
    const { bb, events } = setup();
    const first = await loadDiffEmbed(bb, input);
    events.mockRejectedValue(new Error("history unavailable"));
    expect(await loadDiffEmbed(bb, input)).toEqual(first);
    expect(events).toHaveBeenCalledTimes(1);
  });
  test("explicit workspace includes branch commits and is frozen after shipping", async () => {
    const { bb, diff } = setup();
    const request = { ...input, source: "workspace" as const };
    const first = await loadDiffEmbed(bb, request);
    expect(diff).toHaveBeenCalledWith({
      environmentId: "e",
      target: "all",
      mergeBaseBranch: "origin/main",
    });
    diff.mockRejectedValue(new Error("shipped"));
    expect(await loadDiffEmbed(bb, request)).toEqual(first);
  });
  test("commit source is exact and isolated from workspace snapshots", async () => {
    const { bb, diff } = setup();
    await loadDiffEmbed(bb, { ...input, source: "workspace" });
    const sha = "a".repeat(40);
    expect(await loadDiffEmbed(bb, { ...input, source: "commit", sha })).toMatchObject({
      source: `Commit: ${sha}`,
    });
    expect(diff).toHaveBeenLastCalledWith({ environmentId: "e", target: "commit", sha });
  });
  test("missing exact turn never uses another turn or current workspace", async () => {
    const { bb, diff } = setup();
    expect(await loadDiffEmbed(bb, { ...input, turnId: "missing" })).toMatchObject({
      status: "error",
    });
    expect(diff).not.toHaveBeenCalled();
  });
  test("explicit unavailable commit never falls back", async () => {
    const { bb, diff, events } = setup();
    diff.mockRejectedValue(new Error("commit not found"));
    expect(
      await loadDiffEmbed(bb, { ...input, source: "commit", sha: "b".repeat(40) }),
    ).toMatchObject({ status: "error", message: "commit not found" });
    expect(events).not.toHaveBeenCalled();
  });
  test("reopens the original shipped snapshot schema and payload", async () => {
    const { bb, events } = setup();
    const db = bb.storage.database();
    bb.storage.migrate(db, diffSnapshotMigrations);
    db.prepare("INSERT INTO diff_snapshots VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      "t",
      "m",
      "diff",
      "a.ts",
      0,
      0,
      JSON.stringify({
        status: "ready",
        kind: "diff",
        path: "a.ts",
        label: "a.ts",
        patch,
        truncated: false,
        unity: { legacy: true },
      }),
    );
    expect(await loadDiffEmbed(bb, input)).toMatchObject({ source: "Saved workspace diff", patch });
    expect(events).not.toHaveBeenCalled();
    expect(snapshotDatabase(bb)).toBe(db);
  });
});
test("proposal selects a file and confines the read to thread storage", async () => {
  const { bb, read, diff } = setup();
  read.mockResolvedValue({
    content: patch + patch.replaceAll("a.ts", "b.ts"),
    contentEncoding: "utf8",
  });
  expect(await loadDiffEmbed(bb, { kind: "patch", threadId: "t", file: "p.patch" })).toMatchObject({
    status: "ready",
    files: [{ path: "a.ts" }, { path: "b.ts" }],
  });
  expect(
    await loadDiffEmbed(bb, { kind: "patch", threadId: "t", file: "p.patch", path: "b.ts" }),
  ).toMatchObject({ status: "ready", path: "b.ts" });
  expect(read).toHaveBeenCalledWith({
    hostId: "h",
    rootPath: "/storage/t",
    path: "/storage/t/p.patch",
  });
  expect(diff).not.toHaveBeenCalled();
});
test("rejects escaping paths before storage or source access", async () => {
  for (const path of ["../a", "/a", "a/../b", "a\\b", "a//b"]) {
    const { bb, read, events } = setup();
    expect(await loadDiffEmbed(bb, { ...input, path })).toMatchObject({ status: "error" });
    expect(
      await loadDiffEmbed(bb, { kind: "patch", threadId: "t", file: path + ".patch" }),
    ).toMatchObject({ status: "error" });
    expect(read).not.toHaveBeenCalled();
    expect(events).not.toHaveBeenCalled();
  }
  expect(() => splitPatchFiles(patch.replaceAll("a.ts", "../secret"))).toThrow();
});
test("renames and deletions retain their source identities", () => {
  expect(
    splitPatchFiles(
      "diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\n",
    )[0],
  ).toMatchObject({ path: "new.ts", previousPath: "old.ts" });
  expect(
    splitPatchFiles(
      "diff --git a/a.ts b/a.ts\ndeleted file mode 100644\n--- a/a.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n",
    )[0],
  ).toMatchObject({ path: "a.ts" });
});
test("range boundaries preserve zero-count insertion and deletion anchors", () => {
  const insertion = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -3,0 +4 @@\n+new\n";
  expect(rangePatch("a", insertion, 4)).toMatchObject({
    patch: expect.stringContaining("@@ -3,0 +4,1 @@"),
  });
  expect(rangePatch("a", insertion, 3)).toHaveProperty("empty");
  const deletion = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +0,0 @@\n-old\n";
  expect(rangePatch("a", deletion, 1)).toMatchObject({
    patch: expect.stringContaining("@@ -1,1 +0,0 @@"),
  });
  expect(rangePatch("a", patch, 2, 1)).toHaveProperty("error");
});

test("recorded lookup pages and preserves the newest matching event", async () => {
  const { bb, events } = setup();
  const event = (seq: number, turnId: string, diff = patch) => ({
    type: "turn/diff/updated",
    scope: { kind: "turn", turnId },
    seq,
    data: { diff },
  });
  events.mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => event(300 - i, "other")));
  events.mockResolvedValueOnce([
    event(200, "turn"),
    event(199, "turn", patch.replace("new", "older")),
  ]);
  expect(await loadDiffEmbed(bb, input)).toMatchObject({ status: "ready", patch });
  expect(events.mock.calls[1]?.[0]).toMatchObject({ beforeSeq: "201" });
});
test("failed and empty sources can recover on later loads", async () => {
  const { bb, events } = setup();
  events.mockResolvedValueOnce([]);
  expect(await loadDiffEmbed(bb, input)).toMatchObject({ status: "error" });
  events.mockResolvedValueOnce([
    {
      type: "turn/diff/updated",
      scope: { kind: "turn", turnId: "turn" },
      seq: 2,
      data: { diff: "" },
    },
  ]);
  expect(await loadDiffEmbed(bb, input)).toMatchObject({ status: "empty" });
  expect(await loadDiffEmbed(bb, input)).toMatchObject({ status: "ready", patch });
});
test("simultaneous first loads return the same winning snapshot", async () => {
  const { bb, events } = setup();
  events.mockResolvedValueOnce([
    {
      type: "turn/diff/updated",
      scope: { kind: "turn", turnId: "turn" },
      seq: 2,
      data: { diff: patch },
    },
  ]);
  events.mockResolvedValueOnce([
    {
      type: "turn/diff/updated",
      scope: { kind: "turn", turnId: "turn" },
      seq: 3,
      data: { diff: patch.replace("new", "later") },
    },
  ]);
  const [a, b] = await Promise.all([loadDiffEmbed(bb, input), loadDiffEmbed(bb, input)]);
  expect(a).toMatchObject({ status: "ready" });
  expect(b).toEqual(a);
});
test("unavailable proposal and truncated Git sources remain explicit errors", async () => {
  const { bb, read, diff } = setup();
  read.mockRejectedValue(new Error("root confinement: symlink escaped"));
  expect(
    await loadDiffEmbed(bb, { kind: "patch", threadId: "t", file: "link.patch" }),
  ).toMatchObject({
    status: "error",
    message: expect.stringContaining("Proposal file unavailable: link.patch"),
  });
  diff.mockResolvedValue({ outcome: "available", diff: { diff: patch, truncated: true } });
  expect(
    await loadDiffEmbed(bb, { ...input, source: "commit", sha: "c".repeat(40) }),
  ).toMatchObject({ status: "error", message: expect.stringContaining("truncated") });
});

test("workspace uses BB's detected default branch when no comparison is saved", async () => {
  const { bb, diff, getEnvironment } = setup();
  getEnvironment.mockResolvedValue({ mergeBaseBranch: null, defaultBranch: null });
  expect(await loadDiffEmbed(bb, { ...input, source: "workspace" })).toMatchObject({
    status: "ready",
  });
  expect(diff).toHaveBeenCalledWith({
    environmentId: "e",
    target: "all",
    mergeBaseBranch: "trunk",
  });
});
