import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pinOrdersMatch } from "../hooks/use-pinned-order.ts";

describe("pinOrdersMatch", () => {
  it("sees the same roster and keys as a match", () => {
    const current = new Map([
      ["a", "key-a"],
      ["b", "key-b"],
    ]);
    assert.equal(
      pinOrdersMatch(current, [
        { threadId: "a", pinSortKey: "key-a" },
        { threadId: "b", pinSortKey: "key-b" },
      ]),
      true,
    );
  });

  it("sees a key change, a new pin, and an unpin as changes", () => {
    const current = new Map([
      ["a", "key-a"],
      ["b", "key-b"],
    ]);
    assert.equal(
      pinOrdersMatch(current, [
        { threadId: "a", pinSortKey: "key-a" },
        { threadId: "b", pinSortKey: "key-z" },
      ]),
      false,
    );
    assert.equal(
      pinOrdersMatch(current, [
        { threadId: "a", pinSortKey: "key-a" },
        { threadId: "b", pinSortKey: "key-b" },
        { threadId: "c", pinSortKey: "key-c" },
      ]),
      false,
    );
    assert.equal(pinOrdersMatch(current, [{ threadId: "a", pinSortKey: "key-a" }]), false);
  });
});
