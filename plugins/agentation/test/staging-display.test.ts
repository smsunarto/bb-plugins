import assert from "node:assert/strict";
import test from "node:test";

import {
  annotationMatchesMentionQuery,
  annotationMentionItemId,
  annotationMentionLabel,
  annotationSourceLabel,
  parseAnnotationMentionItemId,
  threadDisplayTitle,
} from "../lib/staging-display.ts";

const mentionAnnotation = {
  id: "1787521014952",
  comment: "  add   button to mention in composer  ",
  element: "list item",
  bb: {
    route: "/projects/proj_1/threads/thr_source",
    routeLabel: "thread thr_source",
    pluginId: "agentation",
    surface: "composerBanner",
    surfaceId: "staged-annotations",
    threadId: "thr_source",
    projectId: "proj_1",
  },
};

test("a thread uses its human title before its generated fallback", () => {
  assert.equal(
    threadDisplayTitle({ title: " Fix the banner ", titleFallback: "New thread" }),
    "Fix the banner",
  );
});

test("an unnamed thread uses its generated fallback", () => {
  assert.equal(
    threadDisplayTitle({ title: null, titleFallback: " Investigate feedback " }),
    "Investigate feedback",
  );
  assert.equal(threadDisplayTitle({ title: null, titleFallback: null }), "Untitled thread");
});

test("a staged annotation shows its resolved thread title instead of the id", () => {
  assert.equal(
    annotationSourceLabel(
      {
        route: "/projects/proj_1/threads/thr_source",
        routeLabel: "thread thr_source",
        threadId: "thr_source",
      },
      { thr_source: "Agentation polish" },
    ),
    "thread: Agentation polish",
  );
});

test("an unavailable thread still identifies the source type", () => {
  assert.equal(
    annotationSourceLabel(
      {
        route: "/projects/proj_1/threads/thr_missing",
        routeLabel: "thread thr_missing",
        threadId: "thr_missing",
      },
      {},
    ),
    "thread: unavailable",
  );
});

test("a non-thread annotation keeps its route label", () => {
  assert.equal(
    annotationSourceLabel({ route: "/settings", routeLabel: "Settings", threadId: null }, {}),
    "Settings",
  );
});

test("an annotation mention identifies its source and feedback", () => {
  assert.equal(
    annotationMentionLabel(mentionAnnotation, "thread: Agentation polish"),
    "[thread: Agentation polish] list item → add button to mention in composer",
  );

  assert.equal(
    annotationMentionLabel(
      {
        ...mentionAnnotation,
        comment: "x".repeat(100),
      },
      "Settings",
    ),
    `[Settings] list item → ${"x".repeat(44)}…`,
  );
  assert.equal(
    annotationMentionLabel(
      {
        ...mentionAnnotation,
        element: "VeryLongReactComponentPath".repeat(3),
      },
      "Settings",
    ),
    "[Settings] VeryLongReactComponentPa… → add button to mention in composer",
  );
  assert.equal(
    annotationMentionLabel(
      {
        ...mentionAnnotation,
        comment: "",
        element: "",
      },
      "",
    ),
    "[unknown location] annotation → 1787521014952",
  );
});

test("annotation mention search covers ids, feedback, owners, and routes", () => {
  assert.equal(annotationMatchesMentionQuery(mentionAnnotation, "178752"), true);
  assert.equal(annotationMatchesMentionQuery(mentionAnnotation, "mention"), true);
  assert.equal(annotationMatchesMentionQuery(mentionAnnotation, "agentation"), true);
  assert.equal(annotationMatchesMentionQuery(mentionAnnotation, "thr_source"), true);
  assert.equal(annotationMatchesMentionQuery(mentionAnnotation, "missing"), false);
});

test("an annotation mention carries its destination thread through resolution", () => {
  const itemId = annotationMentionItemId("ann/1", "thr/target");
  assert.deepEqual(parseAnnotationMentionItemId(itemId), {
    annotationId: "ann/1",
    threadId: "thr/target",
  });
  assert.deepEqual(parseAnnotationMentionItemId("1787554470191"), {
    annotationId: "1787554470191",
    threadId: null,
  });
});
