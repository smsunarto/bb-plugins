import { test } from "bun:test";
import assert from "node:assert/strict";
import type { CanvasSource } from "../../shared/document.ts";
import { fakeBb, fileKeyOf } from "../fake-bb.ts";
import { source } from "./source.ts";

const canvasSource: CanvasSource = {
  kind: "workspace",
  environmentId: "env1",
  path: "notes/a.canvas.mdx",
};
const environments = { env1: { hostId: "host-a", path: "/repo" } };
const key = fileKeyOf("host-a", "/repo", "/repo/notes/a.canvas.mdx");

test("source returns the raw text with its sha", async () => {
  const bb = fakeBb({ environments, files: { [key]: { content: "# hi\n", sha256: "abc" } } });
  assert.deepEqual(await source.execute({ bb }, { source: canvasSource }), {
    status: "ok",
    sha256: "abc",
    content: "# hi\n",
  });
});

test("source maps read failures onto unreadable reasons", async () => {
  const bb = fakeBb({ environments });
  const result = await source.execute({ bb }, { source: canvasSource });
  assert.equal(result.status, "unreadable");
  if (result.status === "unreadable") assert.equal(result.reason, "missing");
});
