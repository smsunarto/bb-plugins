import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { retainUnchangedThreads } from "../lib/stable-threads.ts";

const thread = (id: string, title: string) => ({
  id,
  title,
  environment: { id: `env-${id}`, branchName: "main" },
  activity: { added: 1, removed: 0 },
});

describe("retainUnchangedThreads", () => {
  it("keeps the previous object for every thread bb rebuilt without a change", () => {
    const previous = [thread("a", "Alpha"), thread("b", "Beta"), thread("c", "Gamma")];
    // bb's rename of "b" hands back fresh objects for all three threads.
    const next = [thread("a", "Alpha"), thread("b", "Beta, renamed"), thread("c", "Gamma")];

    const retained = retainUnchangedThreads(previous, next);

    assert.equal(retained[0], previous[0]);
    assert.equal(retained[1], next[1]);
    assert.equal(retained[2], previous[2]);
    assert.equal(retained[1]!.title, "Beta, renamed");
  });

  it("returns the previous list when nothing changed", () => {
    const previous = [thread("a", "Alpha"), thread("b", "Beta")];
    assert.equal(
      retainUnchangedThreads(previous, [thread("a", "Alpha"), thread("b", "Beta")]),
      previous,
    );
  });

  it("treats a nested field change, a reorder, or a removal as a new list", () => {
    const previous = [thread("a", "Alpha"), thread("b", "Beta")];
    const branchMoved = {
      ...thread("a", "Alpha"),
      environment: { id: "env-a", branchName: "next" },
    };

    const nested = retainUnchangedThreads(previous, [branchMoved, thread("b", "Beta")]);
    assert.equal(nested[0], branchMoved);
    assert.equal(nested[1], previous[1]);

    const reordered = retainUnchangedThreads(previous, [thread("b", "Beta"), thread("a", "Alpha")]);
    assert.deepEqual(reordered, [previous[1], previous[0]]);
    assert.notEqual(reordered, previous);

    assert.deepEqual(retainUnchangedThreads(previous, [thread("b", "Beta")]), [previous[1]]);
  });
});
