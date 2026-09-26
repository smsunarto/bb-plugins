import { test } from "bun:test";
import assert from "node:assert/strict";
import type { CanvasSource } from "../../shared/document.ts";
import { fakeBb } from "../fake-bb.ts";
import { preview } from "./preview.ts";

function withPreviews(bb: ReturnType<typeof fakeBb>) {
  const leases: { hostId?: string; rootPath: string }[] = [];
  Object.assign(bb.sdk.files, {
    async createPreview(args: { hostId?: string; rootPath: string }) {
      leases.push(args);
      return { baseUrl: "/preview/lease", expiresAtMs: 99 };
    },
  });
  return leases;
}

test("preview serves the worktree and locates the file inside it", async () => {
  const bb = fakeBb({ environments: { env1: { hostId: "host-a", path: "/repo" } } });
  const leases = withPreviews(bb);
  const source: CanvasSource = { kind: "workspace", environmentId: "env1", path: "docs/a.mdx" };
  assert.deepEqual(await preview.execute({ bb }, { source }), {
    baseUrl: "/preview/lease",
    expiresAtMs: 99,
    path: "docs/a.mdx",
  });
  assert.deepEqual(leases, [{ hostId: "host-a", rootPath: "/repo" }]);
});

test("preview serves a host file's own directory", async () => {
  const bb = fakeBb({});
  const leases = withPreviews(bb);
  const source: CanvasSource = { kind: "host", hostId: "host-b", path: "/notes/deep/a.mdx" };
  const result = await preview.execute({ bb }, { source });
  assert.equal(result.path, "a.mdx");
  assert.deepEqual(leases, [{ hostId: "host-b", rootPath: "/notes/deep" }]);
});
