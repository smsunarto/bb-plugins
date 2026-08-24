import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";

import type { Annotation, BbContext } from "../lib/afs.ts";
import {
  advanceTurnAssignments,
  claimStagedAnnotations,
  completeDispatch,
  discardStagedAnnotations,
  failDispatch,
  getAnnotationRouting,
  listStagedAnnotations,
  recoverInterruptedDispatches,
  recoverInterruptedTurnAssignments,
  restageAnnotation,
  restageTurnAssignments,
} from "../lib/staging.ts";
import {
  getAnnotation,
  migrations,
  openSession,
  setAnnotationStatus,
  upsertAnnotation,
} from "../lib/store.ts";

const ROUTING_MIGRATION_START = 7;

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  for (const statement of migrations) db.exec(statement);
  return db;
}

function seed(db: Database.Database, id = "ann_1") {
  const session = openSession(db, {
    url: "http://localhost/threads/thr_source",
    route: "/threads/thr_source",
    title: "bb",
    threadId: "thr_source",
    projectId: null,
  });
  const context: BbContext = {
    route: session.route,
    pluginId: null,
    surface: null,
    surfaceId: null,
    threadId: session.threadId,
    projectId: session.projectId,
    routeLabel: "thread thr_source",
  };
  const annotation: Annotation = {
    id,
    comment: `Feedback ${id}`,
    elementPath: "body > main > button",
    timestamp: Date.now(),
    x: 10,
    y: 20,
    element: "button",
  };

  return upsertAnnotation(db, {
    sessionId: session.id,
    annotation,
    bb: context,
  });
}

test("new open annotations enter staging", () => {
  const db = freshDb();
  seed(db);

  assert.deepEqual(
    listStagedAnnotations(db).map((annotation) => annotation.id),
    ["ann_1"],
  );
  assert.equal(getAnnotationRouting(db, "ann_1")?.state, "staged");
});

test("one displayed staged annotation can be dismissed without touching the rest", () => {
  const db = freshDb();
  seed(db, "ann_1");
  seed(db, "ann_2");

  const result = discardStagedAnnotations(db, ["ann_1"]);

  assert.equal(result.outcome, "discarded");
  if (result.outcome !== "discarded") assert.fail("expected discard");
  assert.deepEqual(
    result.annotations.map((annotation) => annotation.id),
    ["ann_1"],
  );
  assert.equal(getAnnotation(db, "ann_1")?.status, "dismissed");
  assert.equal(getAnnotation(db, "ann_1")?.resolvedBy, "human");
  assert.equal(getAnnotationRouting(db, "ann_1"), null);
  assert.deepEqual(
    listStagedAnnotations(db).map((annotation) => annotation.id),
    ["ann_2"],
  );
});

test("a stale discard changes nothing after one requested annotation is claimed", () => {
  const db = freshDb();
  seed(db, "ann_1");
  seed(db, "ann_2");
  const claim = claimStagedAnnotations(db, {
    annotationIds: ["ann_1"],
    threadId: "thr_target",
  });
  assert.equal(claim.outcome, "claimed");

  assert.deepEqual(discardStagedAnnotations(db, ["ann_1", "ann_2"]), {
    outcome: "stale",
  });
  assert.notEqual(getAnnotation(db, "ann_1"), null);
  assert.notEqual(getAnnotation(db, "ann_2"), null);
  assert.equal(getAnnotationRouting(db, "ann_1")?.state, "sending");
  assert.equal(getAnnotationRouting(db, "ann_2")?.state, "staged");
});

test("a send claim is stale after the requested annotation is discarded", () => {
  const db = freshDb();
  seed(db);

  assert.equal(discardStagedAnnotations(db, ["ann_1"]).outcome, "discarded");
  assert.deepEqual(
    claimStagedAnnotations(db, {
      annotationIds: ["ann_1"],
      threadId: "thr_target",
    }),
    { outcome: "stale" },
  );
  assert.equal(getAnnotation(db, "ann_1")?.status, "dismissed");
});

test("discard dismisses the displayed snapshot but preserves newer staging", () => {
  const db = freshDb();
  seed(db, "ann_displayed_1");
  seed(db, "ann_displayed_2");
  seed(db, "ann_new");

  const result = discardStagedAnnotations(db, ["ann_displayed_1", "ann_displayed_2"]);

  assert.equal(result.outcome, "discarded");
  if (result.outcome !== "discarded") assert.fail("expected discard");
  assert.deepEqual(
    result.annotations.map((annotation) => annotation.id),
    ["ann_displayed_1", "ann_displayed_2"],
  );
  assert.equal(getAnnotation(db, "ann_displayed_1")?.status, "dismissed");
  assert.equal(getAnnotation(db, "ann_displayed_2")?.status, "dismissed");
  assert.notEqual(getAnnotation(db, "ann_new"), null);
  assert.deepEqual(
    listStagedAnnotations(db).map((annotation) => annotation.id),
    ["ann_new"],
  );
});

test("an empty or duplicate discard snapshot is stale", () => {
  const db = freshDb();
  seed(db);

  assert.deepEqual(discardStagedAnnotations(db, []), { outcome: "stale" });
  assert.deepEqual(discardStagedAnnotations(db, ["ann_1", "ann_1"]), {
    outcome: "stale",
  });
  assert.deepEqual(discardStagedAnnotations(db, ["ann_1", "ann_missing"]), {
    outcome: "stale",
  });
  assert.equal(getAnnotation(db, "ann_1")?.status, "pending");
});

test("discarded feedback can be reopened into staging", () => {
  const db = freshDb();
  seed(db);
  assert.equal(discardStagedAnnotations(db, ["ann_1"]).outcome, "discarded");

  setAnnotationStatus(db, {
    annotationId: "ann_1",
    status: "pending",
    by: "human",
  });

  assert.equal(getAnnotation(db, "ann_1")?.status, "pending");
  assert.equal(getAnnotationRouting(db, "ann_1")?.state, "staged");
});

test("the routing migration stages existing open annotations", () => {
  const db = new Database(":memory:");
  for (const statement of migrations.slice(0, ROUTING_MIGRATION_START)) {
    db.exec(statement);
  }
  seed(db);

  for (const statement of migrations.slice(ROUTING_MIGRATION_START)) {
    db.exec(statement);
  }

  assert.equal(getAnnotationRouting(db, "ann_1")?.state, "staged");
});

test("an exact staged snapshot can only be claimed once", () => {
  const db = freshDb();
  seed(db, "ann_1");
  seed(db, "ann_2");

  const first = claimStagedAnnotations(db, {
    annotationIds: ["ann_1", "ann_2"],
    threadId: "thr_target",
  });
  assert.equal(first.outcome, "claimed");

  const second = claimStagedAnnotations(db, {
    annotationIds: ["ann_1", "ann_2"],
    threadId: "thr_other",
  });
  assert.deepEqual(second, { outcome: "stale" });

  if (first.outcome !== "claimed") assert.fail("expected a claimed dispatch");
  assert.equal(completeDispatch(db, first.dispatch.id), 2);
  assert.deepEqual(listStagedAnnotations(db), []);
  assert.deepEqual(getAnnotationRouting(db, "ann_1"), {
    annotationId: "ann_1",
    state: "assigned",
    assignedThreadId: "thr_target",
    dispatchId: first.dispatch.id,
    updatedAt: getAnnotationRouting(db, "ann_1")?.updatedAt,
  });
});

test("a failed delivery returns its annotations to staging", () => {
  const db = freshDb();
  seed(db);

  const claim = claimStagedAnnotations(db, {
    annotationIds: ["ann_1"],
    threadId: "thr_target",
  });
  if (claim.outcome !== "claimed") assert.fail("expected a claimed dispatch");

  assert.equal(failDispatch(db, claim.dispatch.id, "send failed"), 1);
  assert.equal(getAnnotationRouting(db, "ann_1")?.state, "staged");
  assert.equal(getAnnotationRouting(db, "ann_1")?.assignedThreadId, null);
});

test("restart recovery returns interrupted dispatches to staging", () => {
  const db = freshDb();
  seed(db);

  const claim = claimStagedAnnotations(db, {
    annotationIds: ["ann_1"],
    threadId: "thr_target",
  });
  assert.equal(claim.outcome, "claimed");

  assert.equal(recoverInterruptedDispatches(db), 1);
  assert.equal(getAnnotationRouting(db, "ann_1")?.state, "staged");
});

test("a failed dispatch does not re-stage feedback closed in flight", () => {
  const db = freshDb();
  seed(db);

  const claim = claimStagedAnnotations(db, {
    annotationIds: ["ann_1"],
    threadId: "thr_target",
  });
  if (claim.outcome !== "claimed") assert.fail("expected a claimed dispatch");

  setAnnotationStatus(db, {
    annotationId: "ann_1",
    status: "resolved",
    by: "agent",
  });
  assert.equal(failDispatch(db, claim.dispatch.id, "send failed"), 1);
  assert.equal(getAnnotationRouting(db, "ann_1"), null);
});

test("an assigned annotation can be staged again", () => {
  const db = freshDb();
  seed(db);

  const claim = claimStagedAnnotations(db, {
    annotationIds: ["ann_1"],
    threadId: "thr_target",
  });
  if (claim.outcome !== "claimed") assert.fail("expected a claimed dispatch");
  completeDispatch(db, claim.dispatch.id);

  const routing = restageAnnotation(db, "ann_1");
  assert.equal(routing?.state, "staged");
  assert.equal(routing?.assignedThreadId, null);
});

test("an unresolved annotation reappears after its assigned turn", () => {
  const db = freshDb();
  seed(db);
  const claim = claimStagedAnnotations(db, {
    annotationIds: ["ann_1"],
    threadId: "thr_target",
  });
  if (claim.outcome !== "claimed") assert.fail("expected a claimed dispatch");
  completeDispatch(db, claim.dispatch.id, { reappearAfterTurn: "awaiting-finish" });

  assert.deepEqual(listStagedAnnotations(db), []);
  assert.equal(restageTurnAssignments(db, "thr_target"), 1);
  assert.deepEqual(
    listStagedAnnotations(db).map((annotation) => annotation.id),
    ["ann_1"],
  );
});

test("a queued annotation waits for its own turn instead of the active turn", () => {
  const db = freshDb();
  seed(db);
  const claim = claimStagedAnnotations(db, {
    annotationIds: ["ann_1"],
    threadId: "thr_target",
  });
  if (claim.outcome !== "claimed") assert.fail("expected a claimed dispatch");
  completeDispatch(db, claim.dispatch.id, { reappearAfterTurn: "awaiting-start" });

  assert.equal(restageTurnAssignments(db, "thr_target"), 0);
  assert.equal(getAnnotationRouting(db, "ann_1")?.state, "assigned");
  assert.equal(advanceTurnAssignments(db, "thr_target"), 1);
  assert.equal(restageTurnAssignments(db, "thr_target"), 1);
  assert.equal(getAnnotationRouting(db, "ann_1")?.state, "staged");
});

test("resolving an assigned annotation prevents it from reappearing", () => {
  const db = freshDb();
  seed(db);
  const claim = claimStagedAnnotations(db, {
    annotationIds: ["ann_1"],
    threadId: "thr_target",
  });
  if (claim.outcome !== "claimed") assert.fail("expected a claimed dispatch");
  completeDispatch(db, claim.dispatch.id, { reappearAfterTurn: "awaiting-finish" });

  setAnnotationStatus(db, {
    annotationId: "ann_1",
    status: "resolved",
    by: "agent",
  });
  assert.equal(getAnnotationRouting(db, "ann_1"), null);
  assert.equal(restageTurnAssignments(db, "thr_target"), 0);
});

test("restart recovery returns open turn assignments to staging", () => {
  const db = freshDb();
  seed(db);
  const claim = claimStagedAnnotations(db, {
    annotationIds: ["ann_1"],
    threadId: "thr_target",
  });
  if (claim.outcome !== "claimed") assert.fail("expected a claimed dispatch");
  completeDispatch(db, claim.dispatch.id, { reappearAfterTurn: "awaiting-start" });

  assert.equal(recoverInterruptedTurnAssignments(db), 1);
  assert.equal(getAnnotationRouting(db, "ann_1")?.state, "staged");
});

test("closed annotations leave the staged list and reopen as staged", () => {
  const db = freshDb();
  seed(db);

  setAnnotationStatus(db, {
    annotationId: "ann_1",
    status: "resolved",
    by: "agent",
  });
  assert.deepEqual(listStagedAnnotations(db), []);
  assert.equal(getAnnotationRouting(db, "ann_1"), null);

  setAnnotationStatus(db, {
    annotationId: "ann_1",
    status: "pending",
    by: "human",
  });
  assert.equal(getAnnotationRouting(db, "ann_1")?.state, "staged");
});
