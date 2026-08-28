import type DatabaseNamespace from "better-sqlite3";

import type { Annotation, BbContext } from "../lib/afs.ts";
import {
  clearSession,
  deleteAnnotations,
  migrations,
  openSession,
  upsertAnnotation,
} from "../lib/store.ts";

type DatabaseConstructor = new (filename: string) => DatabaseNamespace.Database;

export const expectedDeletionCounts = {
  missing: 0,
  single: 1,
  duplicate: 1,
  multiRow: 2,
  clear: 3,
  clearEmpty: 0,
};

const bbContext: BbContext = {
  route: "/threads/thr_contract",
  pluginId: null,
  surface: null,
  surfaceId: null,
  threadId: "thr_contract",
  projectId: null,
  routeLabel: "thread thr_contract",
};

function annotation(id: string): Annotation {
  return {
    id,
    comment: `contract annotation ${id}`,
    elementPath: "body > main",
    timestamp: 1_760_000_000_000,
    x: 40,
    y: 200,
    element: "main",
  };
}

export function runDeletionCountContract(Database: DatabaseConstructor) {
  const db = new Database(":memory:");
  try {
    for (const statement of migrations) db.exec(statement);
    const session = openSession(db, {
      url: "http://localhost:5173/threads/thr_contract",
      route: "/threads/thr_contract",
      title: "bb",
      threadId: "thr_contract",
      projectId: null,
    });
    const add = (id: string) =>
      upsertAnnotation(db, {
        sessionId: session.id,
        annotation: annotation(id),
        bb: bbContext,
      });

    for (const id of ["ann_1", "ann_2", "ann_3", "ann_4"]) add(id);
    const missing = deleteAnnotations(db, ["ann_missing"]);
    const single = deleteAnnotations(db, ["ann_1"]);
    const duplicate = deleteAnnotations(db, ["ann_2", "ann_2"]);
    const multiRow = deleteAnnotations(db, ["ann_3", "ann_missing", "ann_4"]);

    for (const id of ["ann_5", "ann_6", "ann_7"]) add(id);
    const clear = clearSession(db, session.id);
    const clearEmpty = clearSession(db, session.id);

    return { missing, single, duplicate, multiRow, clear, clearEmpty };
  } finally {
    db.close();
  }
}
