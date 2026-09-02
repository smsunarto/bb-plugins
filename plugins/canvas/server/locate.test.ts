import { test } from "bun:test";
import assert from "node:assert/strict";
import { locateSource } from "./locate.ts";
import { fakeBb } from "./fake-bb.ts";

test("workspace sources resolve through the environment host and worktree", async () => {
  const bb = fakeBb({
    environments: { env1: { hostId: "host-a", path: "/work/repo" } },
  });
  const result = await locateSource(bb, {
    kind: "workspace",
    environmentId: "env1",
    path: "a.canvas.mdx",
  });
  assert.deepEqual(result, {
    ok: true,
    location: { hostId: "host-a", path: "/work/repo/a.canvas.mdx", rootPath: "/work/repo" },
  });
  assert.deepEqual(bb.calls.environmentsGet, [{ environmentId: "env1" }]);
});

test("workspace sources without a worktree are unreadable", async () => {
  const bb = fakeBb({ environments: { env1: { hostId: "host-a", path: null } } });
  const result = await locateSource(bb, {
    kind: "workspace",
    environmentId: "env1",
    path: "a.canvas.mdx",
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "no-worktree");
});

test("workspace lookup failures surface as host-offline", async () => {
  const bb = fakeBb({});
  const result = await locateSource(bb, { kind: "workspace", environmentId: "missing", path: "a" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "host-offline");
});

test("thread-storage sources resolve through the thread storage location", async () => {
  const bb = fakeBb({ threads: { t1: { hostId: "host-b", storageRootPath: "/storage/t1" } } });
  const result = await locateSource(bb, {
    kind: "thread-storage",
    threadId: "t1",
    path: "canvases/x.canvas.mdx",
  });
  assert.deepEqual(result, {
    ok: true,
    location: {
      hostId: "host-b",
      path: "/storage/t1/canvases/x.canvas.mdx",
      rootPath: "/storage/t1",
    },
  });
});

test("host sources use the explicit host id first and the primary host otherwise", async () => {
  const bb = fakeBb({});
  const explicit = await locateSource(bb, {
    kind: "host",
    hostId: "host-c",
    path: "/abs/x.canvas.mdx",
  });
  assert.deepEqual(explicit, {
    ok: true,
    location: { hostId: "host-c", path: "/abs/x.canvas.mdx" },
  });
  const primary = await locateSource(bb, { kind: "host", hostId: null, path: "/abs/x.canvas.mdx" });
  assert.deepEqual(primary, { ok: true, location: { path: "/abs/x.canvas.mdx" } });
  assert.deepEqual(bb.calls.environmentsGet, []);
  assert.deepEqual(bb.calls.storageLocation, []);
});
