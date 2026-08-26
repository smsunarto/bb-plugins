import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { prNumberClassName, prNumberLabel } from "../lib/pr-status.ts";

describe("prNumberClassName", () => {
  it("colours a draft grey, distinct from an open PR", () => {
    assert.equal(
      prNumberClassName({ state: "draft", attention: "draft" }),
      "text-muted-foreground/50",
    );
    assert.equal(prNumberClassName({ state: "open", attention: "none" }), "text-muted-foreground");
    assert.equal(
      prNumberClassName({ state: "open", attention: "ready_to_merge" }),
      "text-success-foreground",
    );
  });

  it("colours a merge-queue PR with the attention token", () => {
    assert.equal(
      prNumberClassName({ state: "open", attention: "queued" }),
      "text-[color:var(--attention)]",
    );
  });

  it("keeps merged purple and failures red", () => {
    assert.equal(
      prNumberClassName({ state: "merged", attention: "merged" }),
      "text-[color:var(--pr-merged)]",
    );
    assert.equal(
      prNumberClassName({ state: "open", attention: "checks_failed" }),
      "text-destructive-text",
    );
    assert.equal(
      prNumberClassName({ state: "open", attention: "conflicts" }),
      "text-destructive-text",
    );
  });

  it("lets attention outrank state so a queued draft still reads as queued", () => {
    assert.equal(
      prNumberClassName({ state: "draft", attention: "queued" }),
      "text-[color:var(--attention)]",
    );
  });
});

describe("prNumberLabel", () => {
  it("names draft and merge-queue for the title", () => {
    assert.equal(prNumberLabel({ state: "draft", attention: "draft" }), "Draft pull request");
    assert.equal(
      prNumberLabel({ state: "open", attention: "queued" }),
      "Pull request in merge queue",
    );
  });
});
