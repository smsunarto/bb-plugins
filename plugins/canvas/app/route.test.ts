import { test } from "bun:test";
import assert from "node:assert/strict";
import type { CanvasSource } from "../shared/source.ts";
import { canvasPanelRoute, decodeCanvasSubPath, encodeCanvasSubPath } from "./route.ts";

const sources: readonly CanvasSource[] = [
  { kind: "workspace", environmentId: "env-1", path: "notes/a.canvas.mdx" },
  { kind: "thread-storage", threadId: "thr_1", path: "canvases/triage.canvas.mdx" },
  { kind: "host", hostId: "host-a", path: "/Users/me/Ünïcode — report.canvas.mdx" },
  { kind: "host", hostId: null, path: "/tmp/x.canvas.mdx" },
];

test("sub-paths round-trip every source kind", () => {
  for (const source of sources) {
    const encoded = encodeCanvasSubPath(source);
    assert.match(encoded, /^[A-Za-z0-9_-]+$/, "one opaque URL-safe segment");
    assert.deepEqual(decodeCanvasSubPath(encoded), source);
  }
});

test("the panel route is the plugin panel plus the encoded sub-path", () => {
  const source = sources[0]!;
  assert.equal(canvasPanelRoute(source), `/plugins/canvas/canvas/${encodeCanvasSubPath(source)}`);
});

test("decode rejects malformed or incomplete sub-paths", () => {
  const encode = (value: unknown): string =>
    btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  for (const bad of [
    "",
    "not base64!",
    encode("text"),
    encode({ k: "workspace", id: "", p: "a" }),
    encode({ k: "thread-storage", id: null, p: "a" }),
    encode({ k: "host", id: "h", p: "" }),
    encode({ k: "other", id: "h", p: "a" }),
  ]) {
    assert.equal(decodeCanvasSubPath(bad), null, JSON.stringify(bad));
  }
});
