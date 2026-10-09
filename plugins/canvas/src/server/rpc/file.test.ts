import { test } from "bun:test";
import assert from "node:assert/strict";
import type { CanvasSource } from "../../shared/document.ts";
import { fakeBb, fileKeyOf } from "../fake-bb.ts";
import { file } from "./file.ts";

const source: CanvasSource = { kind: "workspace", environmentId: "env1", path: "notes/a.mdx" };
const environments = { env1: { hostId: "host-a", path: "/repo" } };
const key = fileKeyOf("host-a", "/repo", "/repo/notes/a.mdx");

test("file returns the content and hash, then unchanged for the known hash", async () => {
  const bb = fakeBb({ environments, files: { [key]: { content: "# A\n", sha256: "abc" } } });
  assert.deepEqual(await file.execute({ bb }, { source, knownSha256: null }), {
    status: "read",
    sha256: "abc",
    content: "# A\n",
  });
  assert.deepEqual(await file.execute({ bb }, { source, knownSha256: "abc" }), {
    status: "unchanged",
    sha256: "abc",
  });
});

test("file reports a missing file as unreadable", async () => {
  const bb = fakeBb({ environments });
  const result = await file.execute({ bb }, { source, knownSha256: null });
  assert.equal(result.status, "unreadable");
  if (result.status === "unreadable") assert.equal(result.reason, "missing");
});

test("a poll of an unchanged canvas on a remote host costs a stamp, not a read", async () => {
  const path = "/Users/me/repo/notes/poll.mdx";
  const remote = { mac: { hostId: "host-mac", path: "/Users/me/repo" } };
  const fileKey = fileKeyOf("host-mac", "/Users/me/repo", path);
  const stamps = new Map<string, string | null>([
    [fileKeyOf("host-mac", undefined, path), "stamp-1"],
  ]);
  const bb = fakeBb({
    environments: remote,
    stamps,
    files: { [fileKey]: { content: "# A\n", sha256: "v1" } },
  });
  const poll = (knownSha256: string | null) =>
    file.execute(
      { bb },
      { source: { kind: "workspace", environmentId: "mac", path: "notes/poll.mdx" }, knownSha256 },
    );
  assert.deepEqual(await poll(null), { status: "read", sha256: "v1", content: "# A\n" });
  assert.deepEqual(await poll("v1"), { status: "unchanged", sha256: "v1" });
  assert.deepEqual(await poll("v1"), { status: "unchanged", sha256: "v1" });
  assert.deepEqual(await poll("v1"), { status: "unchanged", sha256: "v1" });
  // The opening read and the first poll read; later polls only ask the Mac for a stamp.
  assert.equal(bb.calls.filesRead.length, 2);
  assert.deepEqual(
    bb.calls.hostCalls,
    Array.from({ length: 3 }, () => ({ hostId: "host-mac", method: "stamp", input: { path } })),
  );

  // An agent writes on the Mac: the stamp moves and the next poll reads it.
  bb.store.set(fileKey, { content: "# B\n", sha256: "v2" });
  stamps.set(fileKeyOf("host-mac", undefined, path), "stamp-2");
  assert.deepEqual(await poll("v1"), { status: "read", sha256: "v2", content: "# B\n" });
  // The host cannot vouch for a file written moments ago, so it is read every time.
  stamps.set(fileKeyOf("host-mac", undefined, path), null);
  assert.deepEqual(await poll("v2"), { status: "unchanged", sha256: "v2" });
  assert.deepEqual(await poll("v2"), { status: "unchanged", sha256: "v2" });
  assert.equal(bb.calls.filesRead.length, 5);

  stamps.set(fileKeyOf("host-mac", undefined, path), "absent");
  const deleted = await poll("v2");
  assert.equal(deleted.status === "unreadable" && deleted.reason, "missing");
  assert.equal(bb.calls.filesRead.length, 5);
});
