import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  canvasDocumentSchema,
  collectDiagnostics,
  collectStateIds,
  fileNameOf,
  isCanvasPath,
  narrowSource,
  renderInputSchema,
  stateKeyOf,
  type CanvasNode,
} from "./document.ts";

const span = { line: 1, column: 1, startOffset: 0, endOffset: 1 };

const nodes: readonly CanvasNode[] = [
  { kind: "markdown", source: "# hi", span },
  {
    kind: "component",
    name: "Toggle",
    props: { id: "a", label: "A" },
    span,
    children: [
      {
        kind: "component",
        name: "Tabs",
        props: { id: "b" },
        span,
        children: [
          {
            kind: "diagnostic",
            diagnostic: { code: "disallowed-child", message: "nope", span },
          },
        ],
      },
      { kind: "component", name: "Pill", props: { label: "x" }, span, children: [] },
    ],
  },
  { kind: "diagnostic", diagnostic: { code: "syntax-error", message: "bad", span: null } },
];

test("collectDiagnostics walks nested components in document order", () => {
  const codes = collectDiagnostics({ style: "default", nodes, stateIds: [] }).map((d) => d.code);
  assert.deepEqual(codes, ["disallowed-child", "syntax-error"]);
});

test("collectStateIds returns ids of stateful components only", () => {
  assert.deepEqual(collectStateIds(nodes), ["a", "b"]);
});

test("canvasDocumentSchema round-trips the node tree", () => {
  const parsed = canvasDocumentSchema.parse({ style: "github", nodes, stateIds: ["a", "b"] });
  assert.deepEqual(parsed.nodes, nodes);
  assert.equal(parsed.style, "github");
  assert.equal(
    canvasDocumentSchema.safeParse({ style: "gh", nodes, stateIds: [] }).success,
    false,
    "an unknown style must not pass the wire schema",
  );
});

test("renderInputSchema defaults knownSha256 to null", () => {
  const parsed = renderInputSchema.parse({
    source: { kind: "host", hostId: null, path: "/tmp/a.canvas.mdx" },
  });
  assert.equal(parsed.knownSha256, null);
});

test("isCanvasPath accepts only the .canvas.mdx suffix", () => {
  assert.equal(isCanvasPath("notes/a.canvas.mdx"), true);
  assert.equal(isCanvasPath("A.CANVAS.MDX"), true);
  assert.equal(isCanvasPath("notes/a.mdx"), false);
  assert.equal(isCanvasPath("a.canvas.md"), false);
  assert.equal(isCanvasPath("canvas.mdx"), false);
});

test("fileNameOf returns the last path segment", () => {
  assert.equal(fileNameOf("a/b/c.canvas.mdx"), "c.canvas.mdx");
  assert.equal(fileNameOf("c.canvas.mdx"), "c.canvas.mdx");
  assert.equal(fileNameOf("C:\\x\\y.canvas.mdx"), "y.canvas.mdx");
});

test("narrowSource maps each opener kind to one shape", () => {
  const base = { threadId: null, environmentId: null, projectId: null };
  assert.deepEqual(narrowSource({ ...base, kind: "workspace", environmentId: "env" }, "a.mdx"), {
    ok: true,
    value: { kind: "workspace", environmentId: "env", path: "a.mdx" },
  });
  assert.deepEqual(narrowSource({ ...base, kind: "workspace" }, "a.mdx"), {
    ok: false,
    reason: "no-environment",
  });
  assert.deepEqual(narrowSource({ ...base, kind: "thread-storage", threadId: "t" }, "a.mdx"), {
    ok: true,
    value: { kind: "thread-storage", threadId: "t", path: "a.mdx" },
  });
  assert.deepEqual(narrowSource({ ...base, kind: "thread-storage" }, "a.mdx"), {
    ok: false,
    reason: "no-thread",
  });
  assert.deepEqual(narrowSource({ ...base, kind: "host" }, "/a.mdx"), {
    ok: true,
    value: { kind: "host", hostId: null, path: "/a.mdx" },
  });
  assert.deepEqual(narrowSource({ ...base, kind: "host", experimental_hostId: "h1" }, "/a.mdx"), {
    ok: true,
    value: { kind: "host", hostId: "h1", path: "/a.mdx" },
  });
  assert.deepEqual(narrowSource({ ...base, kind: "host" }, ""), {
    ok: false,
    reason: "empty-path",
  });
});

test("stateKeyOf is stable, injective across kinds, and normalizes separators", () => {
  const a = stateKeyOf({ kind: "workspace", environmentId: "e", path: "x/y.canvas.mdx" });
  assert.equal(a, stateKeyOf({ kind: "workspace", environmentId: "e", path: "x\\y.canvas.mdx" }));
  assert.notEqual(a, stateKeyOf({ kind: "thread-storage", threadId: "e", path: "x/y.canvas.mdx" }));
  assert.notEqual(
    stateKeyOf({ kind: "host", hostId: null, path: "/x" }),
    stateKeyOf({ kind: "host", hostId: "h", path: "/x" }),
  );
});
