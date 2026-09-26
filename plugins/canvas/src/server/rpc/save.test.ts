import { test } from "bun:test";
import assert from "node:assert/strict";
import type { CanvasSource } from "../../shared/document.ts";
import { fakeBb, fileKeyOf } from "../fake-bb.ts";
import { save } from "./save.ts";

const source: CanvasSource = { kind: "thread-storage", threadId: "t1", path: "canvases/a.mdx" };
const threads = { t1: { hostId: "host-a", storageRootPath: "/storage" } };
const key = fileKeyOf("host-a", "/storage", "/storage/canvases/a.mdx");

test("save writes over the expected version", async () => {
  const bb = fakeBb({ threads, files: { [key]: { content: "old", sha256: "v1" } } });
  const result = await save.execute({ bb }, { source, content: "new", expectedSha256: "v1" });
  assert.equal(result.outcome, "written");
  assert.equal((bb.store.get(key) as { content: string }).content, "new");
  assert.deepEqual(bb.calls.filesWrite, [
    {
      hostId: "host-a",
      path: "/storage/canvases/a.mdx",
      rootPath: "/storage",
      content: "new",
      contentEncoding: "utf8",
      expectedSha256: "v1",
    },
  ]);
});

test("save reports a conflict and leaves a newer version alone", async () => {
  const bb = fakeBb({ threads, files: { [key]: { content: "theirs", sha256: "v2" } } });
  const result = await save.execute({ bb }, { source, content: "mine", expectedSha256: "v1" });
  assert.deepEqual(result, { outcome: "conflict" });
  assert.equal((bb.store.get(key) as { content: string }).content, "theirs");
});

test("save without an expected version overwrites", async () => {
  const bb = fakeBb({ threads, files: { [key]: { content: "theirs", sha256: "v2" } } });
  const result = await save.execute({ bb }, { source, content: "mine" });
  assert.equal(result.outcome, "written");
  assert.equal((bb.store.get(key) as { content: string }).content, "mine");
});
