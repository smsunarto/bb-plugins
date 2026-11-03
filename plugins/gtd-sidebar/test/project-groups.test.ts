import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  groupDropReorderArgs,
  applyProjectMove,
  projectDropReorderArgs,
  projectReorderArgs,
} from "../lib/project-groups.ts";

describe("projectReorderArgs", () => {
  const order = ["one", "two", "three"];

  it("moves up past the group above it in the shelf", () => {
    assert.deepEqual(projectReorderArgs("three", "up", ["one", "two", "three"], order), {
      previousProjectId: "one",
      nextProjectId: "two",
    });
  });

  it("moves down past the group below it in the shelf", () => {
    assert.deepEqual(projectReorderArgs("one", "down", ["one", "two", "three"], order), {
      previousProjectId: "two",
      nextProjectId: "three",
    });
  });

  it("jumps a project the shelf does not show", () => {
    // "hidden" has no rows in this shelf; moving "three" up past "two" lands
    // it ahead of both in bb's order, so every shelf agrees.
    assert.deepEqual(
      projectReorderArgs("three", "up", ["two", "three"], ["two", "hidden", "three"]),
      { previousProjectId: null, nextProjectId: "two" },
    );
  });

  it("anchors at the ends with null neighbours", () => {
    assert.deepEqual(projectReorderArgs("three", "up", ["one", "three"], order), {
      previousProjectId: null,
      nextProjectId: "one",
    });
    assert.deepEqual(projectReorderArgs("one", "down", ["one", "three"], order), {
      previousProjectId: "three",
      nextProjectId: null,
    });
  });

  it("refuses moves with no group on that side", () => {
    assert.equal(projectReorderArgs("one", "up", ["one", "two"], order), null);
    assert.equal(projectReorderArgs("two", "down", ["one", "two"], order), null);
  });

  it("refuses projects outside bb's order, including the personal project", () => {
    assert.equal(projectReorderArgs("proj_personal", "up", ["one", "proj_personal"], order), null);
    // Moving onto the personal group is refused too: nothing goes below it.
    assert.equal(projectReorderArgs("one", "down", ["one", "proj_personal"], order), null);
    assert.equal(projectReorderArgs("one", "down", ["one", "gone"], order), null);
  });
});

describe("projectDropReorderArgs", () => {
  const order = ["one", "two", "three"];

  it("drops a group on the shelf's first group to move it to the top", () => {
    // "three" dragged onto "one" lands before it — first in bb's order.
    assert.deepEqual(projectDropReorderArgs("three", "one", "before", order), {
      previousProjectId: null,
      nextProjectId: "one",
    });
  });

  it("drops a group between two others", () => {
    assert.deepEqual(projectDropReorderArgs("one", "two", "after", order), {
      previousProjectId: "two",
      nextProjectId: "three",
    });
    assert.deepEqual(projectDropReorderArgs("three", "two", "before", order), {
      previousProjectId: "one",
      nextProjectId: "two",
    });
  });

  it("drops a group on the shelf's last group to move it to the bottom", () => {
    assert.deepEqual(projectDropReorderArgs("one", "three", "after", order), {
      previousProjectId: "three",
      nextProjectId: null,
    });
  });

  it("jumps projects the shelf does not show, anchored in bb's full order", () => {
    // The shelf only renders ["one", "three"] but bb's order carries
    // "hidden" between them; dropping "one" after "three" lands it at the
    // end of bb's order, past the hidden project too.
    const full = ["one", "hidden", "three"];
    assert.deepEqual(projectDropReorderArgs("one", "three", "after", full), {
      previousProjectId: "three",
      nextProjectId: null,
    });
    // And dropping "three" before "one" jumps it ahead of "hidden" as well.
    assert.deepEqual(projectDropReorderArgs("three", "one", "before", full), {
      previousProjectId: null,
      nextProjectId: "one",
    });
  });

  it("resolves against the full order, not the shelf's visible groups", () => {
    // The shelf's visible groups are ["hidden", "two"] of bb's full
    // ["one", "hidden", "two", "three"]; dropping "two" before "hidden"
    // anchors at the very top, not at the shelf's second slot.
    const full = ["one", "hidden", "two", "three"];
    assert.deepEqual(projectDropReorderArgs("two", "hidden", "before", full), {
      previousProjectId: "one",
      nextProjectId: "hidden",
    });
  });

  it("refuses a drop that asks for the slot the project already holds", () => {
    // "two" dropped after "one" would sit exactly where it is.
    assert.equal(projectDropReorderArgs("two", "one", "after", order), null);
    // "two" dropped before "three" likewise.
    assert.equal(projectDropReorderArgs("two", "three", "before", order), null);
  });

  it("refuses a drop on itself and projects outside bb's order", () => {
    assert.equal(projectDropReorderArgs("one", "one", "after", order), null);
    // The personal project is never in bb's order, so it cannot move and
    // nothing can land relative to it.
    assert.equal(projectDropReorderArgs("proj_personal", "one", "before", order), null);
    assert.equal(projectDropReorderArgs("one", "proj_personal", "after", order), null);
    assert.equal(projectDropReorderArgs("gone", "one", "before", order), null);
  });
});

describe("groupDropReorderArgs", () => {
  const order = ["a", "b", "c", "d"];

  it("finds the dragged group however far it moved, in either direction", () => {
    assert.deepEqual(groupDropReorderArgs(order, ["b", "c", "a", "d"], order), {
      projectId: "a",
      args: { previousProjectId: "c", nextProjectId: "d" },
    });
    assert.deepEqual(groupDropReorderArgs(order, ["b", "c", "d", "a"], order), {
      projectId: "a",
      args: { previousProjectId: "d", nextProjectId: null },
    });
    assert.deepEqual(groupDropReorderArgs(order, ["d", "a", "b", "c"], order), {
      projectId: "d",
      args: { previousProjectId: null, nextProjectId: "a" },
    });
  });

  it("anchors on bb's full order when the shelf shows only some projects", () => {
    assert.deepEqual(groupDropReorderArgs(["a", "c"], ["c", "a"], order), {
      projectId: "c",
      args: { previousProjectId: null, nextProjectId: "a" },
    });
  });

  it("ignores a drop that changes nothing or is more than one move", () => {
    assert.equal(groupDropReorderArgs(order, order, order), null);
    assert.equal(groupDropReorderArgs(order, ["b", "a", "d", "c"], order), null);
  });
});

describe("applyProjectMove", () => {
  const order = ["one", "two", "three"];

  it("predicts the order the resolved anchors describe", () => {
    assert.deepEqual(
      applyProjectMove(order, "three", { previousProjectId: null, nextProjectId: "one" }),
      ["three", "one", "two"],
    );
    assert.deepEqual(
      applyProjectMove(order, "one", { previousProjectId: "three", nextProjectId: null }),
      ["two", "three", "one"],
    );
    assert.deepEqual(
      applyProjectMove(order, "one", { previousProjectId: "two", nextProjectId: "three" }),
      ["two", "one", "three"],
    );
  });

  it("moves within the full order, hidden projects included", () => {
    assert.deepEqual(
      applyProjectMove(["one", "hidden", "three"], "three", {
        previousProjectId: null,
        nextProjectId: "one",
      }),
      ["three", "one", "hidden"],
    );
  });
});
