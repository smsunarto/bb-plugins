import { expect, test } from "bun:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createTodoReader, todoArgsFromEvent } from "../src/server/lib/rpiv-todos.ts";
import { replayTodoArgs } from "../src/server/lib/rpiv-todo-replay.ts";

type Event = Parameters<typeof todoArgsFromEvent>[0];
function pageOf(
  rows: Event[],
  input: { afterSeq?: string; beforeSeq?: string; limit?: string; order?: "asc" | "desc" },
) {
  const selected = rows.filter(
    (row) => row.seq > Number(input.afterSeq ?? 0) && row.seq < Number(input.beforeSeq ?? Infinity),
  );
  return (input.order === "desc" ? selected.reverse() : selected).slice(
    0,
    Number(input.limit ?? 100),
  );
}
function event(seq: number, args: Record<string, unknown>, extra = {}): Event {
  return {
    id: String(seq),
    scope: { kind: "thread" },
    threadId: "t1",
    seq,
    createdAt: seq,
    type: "item/completed",
    data: {
      providerThreadId: "provider-t1",
      item: {
        id: String(seq),
        type: "toolCall",
        tool: "todo",
        status: "completed",
        arguments: args,
        ...extra,
      },
    },
  };
}

function clearEvent(seq: number, status = "completed"): Event {
  return {
    id: String(seq),
    scope: { kind: "thread" },
    threadId: "t1",
    seq,
    createdAt: seq,
    type: "system/operation",
    data: { operation: "context_clear", operationId: "clear1", status, message: "Clear context" },
  };
}

test("completed context clears reset task ids in both cold and incremental reads", async () => {
  const rows = [event(1, { action: "create", subject: "Old task" }), clearEvent(2, "failed")];
  const { bb, harness } = createFakePluginHost({
    pluginId: "kitchen-sink",
    sdk: {
      threads: { events: { list: async (input) => pageOf(rows, input) } },
    },
  });
  const warm = createTodoReader(bb);
  expect((await warm.read("t1")).items[0]?.text).toBe("Old task");
  rows.push(
    clearEvent(3),
    event(4, { action: "create", subject: "Fresh task" }),
    event(5, { action: "update", id: 1, status: "completed" }),
  );
  const expected = [{ id: "1", text: "Fresh task", status: "completed" }] satisfies Awaited<
    ReturnType<ReturnType<typeof createTodoReader>["read"]>
  >["items"];
  expect((await warm.read("t1")).items).toEqual(expected);
  expect((await createTodoReader(bb).read("t1")).items).toEqual(expected);
  await harness.lifecycle.dispose();
});

test("replays create, update, delete and clear without shifting ids for invalid calls", () => {
  const state = replayTodoArgs([
    { action: "create", subject: "First", activeForm: "Working" },
    { action: "create", subject: "Rejected", blockedBy: [99] },
    { action: "create", subject: "Second", blockedBy: [1] },
    { action: "update", id: 1, status: "in_progress" },
    { action: "update", id: 2, addBlockedBy: [2] },
    { action: "delete", id: 2 },
    { action: "update", id: 2, status: "pending" },
  ]);
  expect(state.tasks.map(({ id, status }) => ({ id, status }))).toEqual([
    { id: 1, status: "in_progress" },
    { id: 2, status: "deleted" },
  ]);
  expect(
    replayTodoArgs([{ action: "clear" }, { action: "create", subject: "New" }], state),
  ).toEqual({ tasks: [{ id: 1, subject: "New", status: "pending" }], nextId: 2 });
});

test("skips pending, failed and error results, including structured tool errors", () => {
  for (const extra of [
    { status: "pending" },
    { status: "failed" },
    { error: "failed" },
    { result: "Error: rejected" },
    { result: { isError: true } },
    { tool: "other" },
  ])
    expect(todoArgsFromEvent(event(1, { action: "create", subject: "Wrong" }, extra))).toBeNull();
});

test("reads completed events in ascending pages, coalesces requests and resumes from its cursor", async () => {
  const rows = Array.from({ length: 101 }, (_, i) =>
    event(i + 1, i === 0 ? { action: "create", subject: "First" } : { action: "list" }),
  );
  const { bb, harness } = createFakePluginHost({
    pluginId: "kitchen-sink",
    sdk: {
      threads: {
        events: {
          list: async (input) => {
            expect(input.types).toEqual(["item/completed", "system/operation"]);
            return pageOf(rows, input);
          },
        },
      },
    },
  });
  const reader = createTodoReader(bb);
  const [a, b] = await Promise.all([reader.read("t1"), reader.read("t1")]);
  expect(a).toEqual(b);
  expect(a).toEqual({ items: [{ id: "1", text: "First", status: "pending" }], truncated: false });
  expect(harness.sdk.callsTo("threads.events.list")).toHaveLength(4);
  rows.push(event(102, { action: "update", id: 1, status: "completed" }));
  expect((await reader.read("t1")).items[0]?.status).toBe("completed");
  expect(harness.sdk.callsTo("threads.events.list")).toHaveLength(6);
  await harness.lifecycle.dispose();
});

test("a settled-turn signal during a read is included before coalesced readers finish", async () => {
  const rows = [event(1, { action: "create", subject: "First" })];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  const { bb, harness } = createFakePluginHost({
    pluginId: "kitchen-sink",
    sdk: {
      threads: {
        events: {
          list: async (input) => {
            const page = pageOf(rows, input);
            if (first) {
              first = false;
              await gate;
            }
            return page;
          },
        },
      },
    },
  });
  const reader = createTodoReader(bb);
  const pending = reader.read("t1");
  rows.push(event(2, { action: "update", id: 1, status: "completed" }));
  reader.invalidate("t1");
  const joined = reader.read("t1");
  release();
  expect((await pending).items[0]?.status).toBe("completed");
  expect((await joined).items[0]?.status).toBe("completed");
  await harness.lifecycle.dispose();
});

test("rebuilds after an edited message replaces events at the same sequence", async () => {
  let rows = [event(1, { action: "create", subject: "Deleted history" })];
  const { bb, harness } = createFakePluginHost({
    pluginId: "kitchen-sink",
    sdk: {
      threads: { events: { list: async (input) => pageOf(rows, input) } },
    },
  });
  const reader = createTodoReader(bb);
  await reader.read("t1");
  rows = [{ ...event(1, { action: "create", subject: "Replacement" }), id: "replacement-event" }];
  expect((await reader.read("t1")).items).toEqual([
    { id: "1", text: "Replacement", status: "pending" },
  ]);
  rows = [];
  expect((await reader.read("t1")).items).toEqual([]);
  await harness.lifecycle.dispose();
});

test("keeps completed pages when a later history read fails", async () => {
  const rows = Array.from({ length: 101 }, (_, i) =>
    event(i + 1, i === 0 ? { action: "create", subject: "First" } : { action: "list" }),
  );
  let fail = true;
  const after: (string | undefined)[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "kitchen-sink",
    sdk: {
      threads: {
        events: {
          list: async (input) => {
            after.push(input.afterSeq);
            if (input.afterSeq === "100" && fail) {
              fail = false;
              throw new Error("deadline");
            }
            return pageOf(rows, input);
          },
        },
      },
    },
  });
  const reader = createTodoReader(bb);
  await expect(reader.read("t1")).rejects.toThrow("deadline");
  expect((await reader.read("t1")).items).toEqual([{ id: "1", text: "First", status: "pending" }]);
  expect(after.filter((value) => value === undefined)).toHaveLength(2); // first page + anchor validation
  expect(after.at(-1)).toBe("100");
  await harness.lifecycle.dispose();
});
