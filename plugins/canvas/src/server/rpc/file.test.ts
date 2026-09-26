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
