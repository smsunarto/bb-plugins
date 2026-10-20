import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rosterFamilyIds, threadFamilyIds } from "../lib/thread-family.ts";

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

describe("rosterFamilyIds", () => {
  it("walks the roster's live descendants without following forks, archives, or cycles", () => {
    const thread = (
      id: string,
      parentThreadId: string | null,
      extra: { originKind?: string; isArchived?: boolean } = {},
    ) => ({
      id,
      parentThreadId,
      originKind: extra.originKind ?? null,
      isArchived: extra.isArchived ?? false,
    });
    const roster = [
      thread("root", "grandchild"),
      thread("child", "root"),
      thread("grandchild", "child"),
      thread("fork", "root", { originKind: "fork" }),
      thread("settled", "root", { isArchived: true }),
      thread("stranger", null),
    ];
    assert.deepEqual(rosterFamilyIds(roster, "root"), ["root", "child", "grandchild"]);
    assert.deepEqual(rosterFamilyIds(roster, "unknown"), ["unknown"]);
  });
});
