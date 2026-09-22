import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { threadFamilyIds } from "../lib/thread-family.ts";

describe("threadFamilyIds", () => {
  it("walks paginated descendants without following forks or cycles", async () => {
    const children = new Map([
      [
        "root",
        [
          { id: "child", originKind: null },
          { id: "fork", originKind: "fork" },
        ],
      ],
      ["child", [{ id: "grandchild", originKind: null }]],
      ["grandchild", [{ id: "root", originKind: null }]],
    ]);
    const ids = await threadFamilyIds(
      "root",
      async (parentId, offset) => (children.get(parentId) ?? []).slice(offset, offset + 2),
      2,
    );
    assert.deepEqual(ids, ["root", "child", "grandchild"]);
  });

  it("propagates a child read failure before a family can be written", async () => {
    await assert.rejects(
      threadFamilyIds(
        "root",
        async () => {
          throw new Error("read failed");
        },
        2,
      ),
      /read failed/,
    );
  });
});
