import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { CanvasSource } from "../../shared/document.ts";
import { fakeBb, fileKeyOf } from "../fake-bb.ts";
import { maxCanvasBytes } from "../parse.ts";
import { render } from "./render.ts";

const sample = readFileSync(
  new URL("../../../examples/flaky-test-triage.canvas.mdx", import.meta.url),
  "utf8",
);
const source: CanvasSource = {
  kind: "workspace",
  environmentId: "env1",
  path: "notes/a.canvas.mdx",
};
const environments = { env1: { hostId: "host-a", path: "/repo" } };
const key = fileKeyOf("host-a", "/repo", "/repo/notes/a.canvas.mdx");

test("render returns the parsed document with sha and mtime", async () => {
  const bb = fakeBb({
    environments,
    files: { [key]: { content: sample, sha256: "abc", modifiedAtMs: 42 } },
  });
  const result = await render.execute({ bb }, { source, knownSha256: null });
  assert.equal(result.status, "rendered");
  if (result.status === "rendered") {
    assert.equal(result.sha256, "abc");
    assert.equal(result.modifiedAtMs, 42);
    assert.equal(result.document.nodes.length, 10);
    assert.deepEqual(result.document.stateIds, []);
  }
  assert.deepEqual(bb.calls.filesRead, [
    { hostId: "host-a", path: "/repo/notes/a.canvas.mdx", rootPath: "/repo" },
  ]);
});

test("render returns unchanged when the known sha matches", async () => {
  const bb = fakeBb({ environments, files: { [key]: { content: sample, sha256: "abc" } } });
  const result = await render.execute({ bb }, { source, knownSha256: "abc" });
  assert.deepEqual(result, { status: "unchanged", sha256: "abc" });
});

test("render returns unparseable with a positioned diagnostic on a hard syntax error", async () => {
  const bb = fakeBb({
    environments,
    files: { [key]: { content: '# hi\n\n<Card title="x">\n\ntext\n', sha256: "s" } },
  });
  const result = await render.execute({ bb }, { source, knownSha256: null });
  assert.equal(result.status, "unparseable");
  if (result.status === "unparseable") {
    assert.equal(result.sha256, "s");
    assert.equal(result.diagnostic.code, "syntax-error");
    assert.equal(result.diagnostic.span?.line, 3);
  }
});

test("render maps read failures onto unreadable reasons", async () => {
  const missing = fakeBb({ environments });
  assert.deepEqual(await render.execute({ bb: missing }, { source, knownSha256: null }), {
    status: "unreadable",
    reason: "missing",
    detail: "ENOENT: no such file or directory, open '/repo/notes/a.canvas.mdx'",
  });
  const binary = fakeBb({
    environments,
    files: { [key]: { content: "AAAA", contentEncoding: "base64" } },
  });
  const binaryResult = await render.execute({ bb: binary }, { source, knownSha256: null });
  assert.equal(binaryResult.status, "unreadable");
  if (binaryResult.status === "unreadable") assert.equal(binaryResult.reason, "binary");
  const large = fakeBb({
    environments,
    files: { [key]: { content: "x".repeat(maxCanvasBytes + 1) } },
  });
  const largeResult = await render.execute({ bb: large }, { source, knownSha256: null });
  if (largeResult.status === "unreadable") assert.equal(largeResult.reason, "too-large");
  const offline = fakeBb({ environments, files: { [key]: new Error("host daemon disconnected") } });
  const offlineResult = await render.execute({ bb: offline }, { source, knownSha256: null });
  if (offlineResult.status === "unreadable") assert.equal(offlineResult.reason, "host-offline");
  const noWorktree = fakeBb({ environments: { env1: { hostId: "host-a", path: null } } });
  const noWorktreeResult = await render.execute({ bb: noWorktree }, { source, knownSha256: null });
  if (noWorktreeResult.status === "unreadable")
    assert.equal(noWorktreeResult.reason, "no-worktree");
});
