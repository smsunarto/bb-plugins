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
  restageThreadAssignments,
  restageTurnAssignments,
  turnAssignmentThreadIds,
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
    threadId: "thr_target",
    dispatchId: first.dispatch.id,
    updatedAt: getAnnotationRouting(db, "ann_1")?.updatedAt,
  });
});

test("a claimed annotation names no thread until delivery is confirmed", () => {
  const db = freshDb();
  seed(db);

  const claim = claimStagedAnnotations(db, {
    annotationIds: ["ann_1"],
    threadId: "thr_target",
  });
  if (claim.outcome !== "claimed") assert.fail("expected a claimed dispatch");

  assert.deepEqual(getAnnotationRouting(db, "ann_1"), {
    annotationId: "ann_1",
    state: "sending",
    dispatchId: claim.dispatch.id,
    updatedAt: getAnnotationRouting(db, "ann_1")?.updatedAt,
  });
});

test("an assigned routing row that lost its thread is rejected when read", () => {
  const db = freshDb();
  seed(db);

  const claim = claimStagedAnnotations(db, {
    annotationIds: ["ann_1"],
    threadId: "thr_target",
  });
  if (claim.outcome !== "claimed") assert.fail("expected a claimed dispatch");
  completeDispatch(db, claim.dispatch.id);

  db.prepare(`UPDATE annotation_routing SET assigned_thread_id = NULL WHERE annotation_id = ?`).run(
    "ann_1",
  );
  assert.throws(() => getAnnotationRouting(db, "ann_1"));
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
  assert.deepEqual(getAnnotationRouting(db, "ann_1"), {
    annotationId: "ann_1",
    state: "staged",
    updatedAt: getAnnotationRouting(db, "ann_1")?.updatedAt,
  });
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
  assert.deepEqual(routing, {
    annotationId: "ann_1",
    state: "staged",
    updatedAt: routing?.updatedAt,
  });
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

function assignTogether(
  db: Database.Database,
  threadId: string,
  phase: "awaiting-start" | "awaiting-finish",
) {
  seed(db, "ann_pending");
  seed(db, "ann_acked");
  const claim = claimStagedAnnotations(db, {
    annotationIds: ["ann_pending", "ann_acked"],
    threadId,
  });
  if (claim.outcome !== "claimed") assert.fail("expected a claimed dispatch");
  completeDispatch(db, claim.dispatch.id, { reappearAfterTurn: phase });
  setAnnotationStatus(db, { annotationId: "ann_acked", status: "acknowledged", by: "agent" });
}

function assertAcknowledgedStaysAssigned(db: Database.Database, threadId: string) {
  assert.deepEqual(
    listStagedAnnotations(db).map((annotation) => annotation.id),
    ["ann_pending"],
  );
  const kept = getAnnotationRouting(db, "ann_acked");
  assert.equal(kept?.state, "assigned");
  assert.equal(kept?.state === "assigned" ? kept.threadId : null, threadId);
  assert.deepEqual(turnAssignmentThreadIds(db), []);
}

test("after a turn only the annotations the agent never acknowledged reappear", () => {
  const db = freshDb();
  assignTogether(db, "thr_target", "awaiting-finish");

  assert.equal(restageTurnAssignments(db, "thr_target"), 1);
  assertAcknowledgedStaysAssigned(db, "thr_target");
});

test("a failed turn also keeps acknowledged annotations assigned", () => {
  const db = freshDb();
  assignTogether(db, "thr_target", "awaiting-start");

  assert.equal(restageTurnAssignments(db, "thr_target", { includeAwaitingStart: true }), 1);
  assertAcknowledgedStaysAssigned(db, "thr_target");
});

test("restart recovery keeps acknowledged annotations assigned", () => {
  const db = freshDb();
  assignTogether(db, "thr_target", "awaiting-finish");

  assert.equal(recoverInterruptedTurnAssignments(db), 1);
  assertAcknowledgedStaysAssigned(db, "thr_target");
});

function send(
  db: Database.Database,
  threadId: string,
  phase: "awaiting-start" | "awaiting-finish",
  options: { reassign?: boolean } = {},
) {
  const claim = claimStagedAnnotations(db, { annotationIds: ["ann_1"], threadId, ...options });
  if (claim.outcome !== "claimed") return claim;
  completeDispatch(db, claim.dispatch.id, { reappearAfterTurn: phase });
  return claim;
}

function acknowledge(db: Database.Database, annotationId = "ann_1") {
  setAnnotationStatus(db, { annotationId, status: "acknowledged", by: "agent" });
}

function assignedThread(db: Database.Database, annotationId = "ann_1") {
  const routing = getAnnotationRouting(db, annotationId);
  return routing?.state === "assigned" ? routing.threadId : routing?.state;
}

test("an annotation acknowledged while staged is pending again once sent", () => {
  const db = freshDb();
  seed(db);
  acknowledge(db);

  const claim = send(db, "thr_T", "awaiting-start");
  assert.equal(claim.outcome === "claimed" && claim.reopened, 1);
  assert.equal(getAnnotation(db, "ann_1")?.status, "pending");
  assert.equal(restageTurnAssignments(db, "thr_T", { includeAwaitingStart: true }), 1);
  assert.deepEqual(
    listStagedAnnotations(db).map((annotation) => annotation.id),
    ["ann_1"],
  );
});

test("restart recovery re-stages an annotation acknowledged before it was sent", () => {
  const db = freshDb();
  seed(db);
  acknowledge(db);
  send(db, "thr_T", "awaiting-start");

  assert.equal(recoverInterruptedTurnAssignments(db), 1);
  assert.equal(recoverInterruptedTurnAssignments(db), 0);
  assert.equal(assignedThread(db), "staged");
});

test("staging an acknowledged annotation again ends its acknowledgement", () => {
  const db = freshDb();
  seed(db);
  send(db, "thr_A", "awaiting-finish");
  acknowledge(db);
  assert.equal(restageTurnAssignments(db, "thr_A"), 0);

  assert.equal(restageAnnotation(db, "ann_1")?.state, "staged");
  assert.equal(getAnnotation(db, "ann_1")?.status, "pending");
  send(db, "thr_B", "awaiting-finish");
  assert.equal(restageTurnAssignments(db, "thr_B"), 1);
  assert.equal(assignedThread(db), "staged");
});

test("a deleted thread mid-turn gives back its acknowledged annotations", () => {
  const db = freshDb();
  seed(db);
  send(db, "thr_gone", "awaiting-finish");
  acknowledge(db);

  assert.equal(restageThreadAssignments(db, "thr_gone"), 1);
  assert.equal(assignedThread(db), "staged");
  assert.equal(getAnnotation(db, "ann_1")?.status, "pending");
  assert.deepEqual(turnAssignmentThreadIds(db), []);
});

test("a thread deleted after its turn gives back its acknowledged annotations", () => {
  const db = freshDb();
  seed(db);
  send(db, "thr_gone", "awaiting-finish");
  acknowledge(db);
  assert.equal(restageTurnAssignments(db, "thr_gone"), 0);
  assert.equal(assignedThread(db), "thr_gone");

  assert.equal(restageThreadAssignments(db, "thr_gone"), 1);
  assert.equal(assignedThread(db), "staged");
});

test("restart recovery gives back what a missing thread held, acknowledged or not", () => {
  const db = freshDb();
  seed(db);
  send(db, "thr_gone", "awaiting-finish");
  acknowledge(db);
  assert.equal(restageTurnAssignments(db, "thr_gone"), 0);

  // An existing thread with no turn left keeps its acknowledged annotation.
  assert.equal(recoverInterruptedTurnAssignments(db), 0);
  assert.equal(assignedThread(db), "thr_gone");

  assert.equal(recoverInterruptedTurnAssignments(db, new Set(), new Set(["thr_gone"])), 1);
  assert.equal(assignedThread(db), "staged");
  assert.equal(getAnnotation(db, "ann_1")?.status, "pending");
});

test("mentioning an acknowledged annotation in another thread reassigns it", () => {
  const db = freshDb();
  seed(db);
  send(db, "thr_A", "awaiting-finish");
  acknowledge(db);
  restageTurnAssignments(db, "thr_A");

  assert.equal(send(db, "thr_B", "awaiting-finish").outcome, "stale");
  const claim = send(db, "thr_B", "awaiting-finish", { reassign: true });
  assert.equal(claim.outcome === "claimed" && claim.reopened, 1);
  assert.equal(assignedThread(db), "thr_B");
  assert.equal(getAnnotation(db, "ann_1")?.status, "pending");
  assert.deepEqual(turnAssignmentThreadIds(db), ["thr_B"]);
});

test("a reassigned annotation leaves its previous thread's turn behind", () => {
  const db = freshDb();
  seed(db);
  send(db, "thr_A", "awaiting-finish");
  send(db, "thr_B", "awaiting-start", { reassign: true });

  assert.equal(restageTurnAssignments(db, "thr_A"), 0);
  assert.equal(assignedThread(db), "thr_B");
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

test("restart recovery keeps assignments whose thread is still mid-turn", () => {
  const db = freshDb();
  seed(db, "ann_busy");
  seed(db, "ann_idle");
  for (const [annotationId, threadId] of [
    ["ann_busy", "thr_busy"],
    ["ann_idle", "thr_idle"],
  ] as const) {
    const claim = claimStagedAnnotations(db, { annotationIds: [annotationId], threadId });
    if (claim.outcome !== "claimed") assert.fail("expected a claimed dispatch");
    completeDispatch(db, claim.dispatch.id, { reappearAfterTurn: "awaiting-finish" });
  }
  assert.deepEqual(turnAssignmentThreadIds(db), ["thr_busy", "thr_idle"]);

  assert.equal(recoverInterruptedTurnAssignments(db, new Set(["thr_busy"])), 1);
  assert.equal(getAnnotationRouting(db, "ann_idle")?.state, "staged");
  assert.equal(getAnnotationRouting(db, "ann_busy")?.state, "assigned");
  assert.deepEqual(turnAssignmentThreadIds(db), ["thr_busy"]);

  // The busy thread's next idle event finishes the kept assignment normally.
  assert.equal(restageTurnAssignments(db, "thr_busy"), 1);
  assert.equal(getAnnotationRouting(db, "ann_busy")?.state, "staged");
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
