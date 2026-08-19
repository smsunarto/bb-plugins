import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeJson, type StoredAnnotation } from "../lib/afs.ts";
import {
  renderAnnotation,
  renderAnnotationAssignment,
  renderAnnotationLine,
  renderAnnotations,
} from "../lib/markdown.ts";
import {
  labelForRoute,
  panelPluginIdFromRoute,
  projectIdFromRoute,
  threadIdFromRoute,
} from "../lib/route.ts";

function stored(overrides: Partial<StoredAnnotation> = {}): StoredAnnotation {
  return {
    id: "ann_1",
    comment: "The label wraps at 320px",
    elementPath: "body > main > button.cta",
    timestamp: 1_760_000_000_000,
    x: 40,
    y: 200,
    element: "button",
    sessionId: "ses_1",
    status: "pending",
    kind: "feedback",
    thread: [],
    bb: {
      route: "/plugins/github/issues",
      pluginId: "github",
      surface: "navPanel",
      threadId: null,
      projectId: null,
      routeLabel: "github panel",
    },
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
    resolution: null,
    seq: 1,
    ...overrides,
  } as StoredAnnotation;
}

test("an annotation on a plugin surface names the owning plugin", () => {
  const output = renderAnnotation(stored());
  assert.match(output, /plugin `github` \(navPanel\)/);
  assert.match(output, /body > main > button\.cta/);
  assert.match(output, /The label wraps at 320px/);
});

test("an annotation on the shell says so instead of naming a plugin", () => {
  const output = renderAnnotation(
    stored({
      bb: {
        route: "/",
        pluginId: null,
        surface: null,
        threadId: null,
        projectId: null,
        routeLabel: "home",
      },
    }),
  );
  assert.match(output, /bb app shell/);
  assert.doesNotMatch(output, /plugin `/);
});

test("a placement annotation reads as a layout request", () => {
  const output = renderAnnotation(
    stored({
      kind: "placement",
      comment: "Put a summary card here",
      placement: {
        componentType: "Hero",
        width: 800,
        height: 400,
        scrollY: 0,
      },
    }),
  );
  assert.match(output, /place a `Hero` here, roughly 800×400px/);
});

test("the reply thread and the outcome both render", () => {
  const output = renderAnnotation(
    stored({
      status: "resolved",
      resolution: "clamped the label",
      thread: [
        { id: "m1", role: "agent", content: "24px or 16px?", timestamp: 1 },
        { id: "m2", role: "human", content: "16px", timestamp: 2 },
      ],
    }),
  );
  assert.match(output, /_agent_: 24px or 16px\?/);
  assert.match(output, /_human_: 16px/);
  assert.match(output, /\*\*Resolution:\*\* clamped the label/);
});

test("a batch groups by page and numbers within each one", () => {
  const output = renderAnnotations([
    stored({ id: "ann_1", sessionId: "ses_1" }),
    stored({ id: "ann_2", sessionId: "ses_1" }),
    stored({ id: "ann_3", sessionId: "ses_2" }),
  ]);

  assert.match(output, /3 annotations across 2 pages/);
  assert.match(output, /## Page: ses_1/);
  assert.match(output, /### 1\. button — ann_1/);
  assert.match(output, /### 2\. button — ann_2/);
  assert.match(output, /### 1\. button — ann_3/);
});

test("an empty batch says so rather than rendering an empty heading", () => {
  assert.equal(renderAnnotations([]), "No annotations.");
});

test("a thread assignment is self-contained and preserves React context", () => {
  const output = renderAnnotationAssignment(
    [stored({ reactComponents: "<Sidebar> <Button>" })],
    [],
  );

  assert.match(output, /\*\*React:\*\* <Sidebar> <Button>/);
  assert.match(output, /complete batch assigned to this thread/);
  assert.match(output, /Work only on these annotation IDs/);
  assert.match(output, /Do not call `agentation_get_all_pending`/);
});

test("the one-line form carries id, status, and owner", () => {
  const line = renderAnnotationLine(stored({ severity: "blocking" }));
  assert.match(line, /^ann_1\s+pending\s+plugin:github/);
  assert.match(line, /\[blocking\]/);
});

test("sanitizeJson drops what bb's rpc layer would reject", () => {
  const cleaned = sanitizeJson({
    keep: "yes",
    dropped: undefined,
    infinite: Number.POSITIVE_INFINITY,
    nested: { also: undefined, fine: 1 },
  });

  assert.deepEqual(cleaned, {
    keep: "yes",
    infinite: null,
    nested: { fine: 1 },
  });
});

test("bb routes resolve to their thread, project, and panel ids", () => {
  assert.equal(threadIdFromRoute("/threads/thr_abc123"), "thr_abc123");
  assert.equal(threadIdFromRoute("/settings/appearance"), null);
  assert.equal(projectIdFromRoute("/projects/proj_xyz/threads"), "proj_xyz");
  assert.equal(panelPluginIdFromRoute("/plugins/github/issues"), "github");
  assert.equal(panelPluginIdFromRoute("/threads/thr_abc"), null);
});

test("route labels stay short enough to list", () => {
  assert.equal(labelForRoute("/threads/thr_abc"), "thread thr_abc");
  assert.equal(labelForRoute("/plugins/dotfiles/browse"), "dotfiles panel");
  assert.equal(labelForRoute("/"), "home");
  assert.equal(labelForRoute("/settings/plugins"), "settings");
});
