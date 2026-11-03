import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DRAG_KIND, sidebarDragPayload } from "../lib/sidebar-drag.ts";

/** A dnd-kit entry as `active`/`over` present it: an id plus `data.current`. */
function entry(id: unknown, data: unknown) {
  return { id, data: { current: data } };
}

describe("sidebarDragPayload", () => {
  it("decodes a dragged thread row", () => {
    assert.deepEqual(sidebarDragPayload(entry("thr_1", { kind: DRAG_KIND.thread })), {
      kind: "thread",
      threadId: "thr_1",
    });
  });

  it("decodes a dragged project group, sortable data and all", () => {
    // useSortable merges { sortable: {...} } into the entry's data; the kind
    // marker survives beside it.
    assert.deepEqual(
      sidebarDragPayload(
        entry("proj_1", {
          kind: DRAG_KIND.project,
          sortable: { containerId: "nextAction", items: ["proj_1"], index: 0 },
        }),
      ),
      { kind: "project", projectId: "proj_1" },
    );
  });

  it("a thread payload never reads as a project, nor a project as a thread", () => {
    const thread = sidebarDragPayload(entry("thr_1", { kind: DRAG_KIND.thread }));
    const project = sidebarDragPayload(entry("proj_1", { kind: DRAG_KIND.project }));
    assert.equal(thread?.kind, "thread");
    assert.equal(project?.kind, "project");
    // The union members carry disjoint id fields: a thread payload cannot
    // hand the reorder path a projectId, nor the nest path a threadId.
    assert.equal(thread !== null && "projectId" in thread, false);
    assert.equal(project !== null && "threadId" in project, false);
  });

  it("returns null for the nest droppables a thread drops on", () => {
    // The `thread:`/`project:` drop targets are plain droppables with no
    // data — never confused for a dragged group.
    assert.equal(sidebarDragPayload(entry("thread:thr_1", undefined)), null);
    assert.equal(sidebarDragPayload(entry("project:nextAction:proj_1", undefined)), null);
  });

  it("returns null for entries that are not sidebar drags", () => {
    assert.equal(sidebarDragPayload(null), null);
    assert.equal(sidebarDragPayload(undefined), null);
    assert.equal(sidebarDragPayload(entry("x", null)), null);
    assert.equal(sidebarDragPayload(entry("x", "string")), null);
    assert.equal(sidebarDragPayload(entry("x", {})), null);
    assert.equal(sidebarDragPayload(entry("x", { kind: "other" })), null);
    // A kind marker without a string id is not a payload either.
    assert.equal(sidebarDragPayload(entry(42, { kind: DRAG_KIND.project })), null);
    assert.equal(sidebarDragPayload(entry(undefined, { kind: DRAG_KIND.thread })), null);
  });
});
