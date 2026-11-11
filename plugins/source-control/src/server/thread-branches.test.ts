import { expect, test } from "vitest";
import { createThreadBranches } from "./thread-branches.ts";

const place = { environmentId: "env-a", path: "/repo" };

/** A thread that ran `but branch new scott/one` in the checkout, and nothing else. */
function fakeBb() {
  const kv = new Map<string, unknown>();
  const event = {
    seq: 1,
    createdAt: 1_000,
    data: {
      item: {
        type: "commandExecution",
        exitCode: 0,
        command: "but branch new scott/one",
        cwd: "/repo",
      },
    },
  };
  return {
    storage: {
      kv: {
        get: async (key: string) => kv.get(key),
        set: async (key: string, value: unknown) => void kv.set(key, value),
      },
    },
    sdk: {
      threads: {
        events: {
          list: async (input: { order: string; afterSeq?: string }) =>
            input.order === "desc" || Number(input.afterSeq ?? 0) < 1 ? [event] : [],
        },
        experimental_listDescendants: async () => ({ threads: [] }),
        experimental_listAncestors: async () => ({ threads: [] }),
        list: async () => [],
      },
    },
    log: { debug: () => undefined },
  };
}

test("a rename from the tab moves the thread's branch to the new name, and it stays there", async () => {
  const branches = createThreadBranches(fakeBb() as never, () => undefined);
  expect(await branches.branchOf("thread-a", place)).toBe("scott/one");
  await branches.renamed("thread-a", place, "scott/one", "scott/two");
  expect(await branches.branchOf("thread-a", place)).toBe("scott/two");
  // A later turn with no new commands keeps it.
  await branches.turnEnded("thread-a", place);
  expect(await branches.branchOf("thread-a", place)).toBe("scott/two");
});

test("a rename of another branch leaves the thread's own alone", async () => {
  const branches = createThreadBranches(fakeBb() as never, () => undefined);
  await branches.renamed("thread-a", place, "scott/other", "scott/else");
  expect(await branches.branchOf("thread-a", place)).toBe("scott/one");
});
