// Adapted from https://github.com/ZhenHuangLab/bb-rpiv-todo-renderer (MIT).
// License: ../../app/rpiv-todo/LICENSE.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  rpivTodoContract,
  RPIV_TODO_CHANNEL,
  RPIV_TODO_EXPAND_SETTING,
} from "../../shared/rpiv-todo.ts";
import type { TodoSnapshot } from "../../shared/rpiv-todo.ts";
import { TODO_TEXT_MAX_LENGTH, type Task, type TaskState } from "../../shared/rpiv-todo-types.ts";
import { replayTodoArgs } from "./rpiv-todo-replay.ts";

const PAGE_SIZE = 100;
const MAX_PAGES = 40;
const EVENT_TYPES = ["item/completed", "system/operation"] as const;
type Event = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["events"]["list"]>>[number];

export function todoArgsFromEvent(row: Event): Record<string, unknown> | null {
  if (row.type !== "item/completed") return null;
  const item = row.data.item;
  if (item.type !== "toolCall" || item.tool !== "todo" || item.status !== "completed" || item.error)
    return null;
  if (typeof item.result === "string" && item.result.trimStart().startsWith("Error:")) return null;
  if (
    item.result &&
    typeof item.result === "object" &&
    "isError" in item.result &&
    item.result.isError === true
  )
    return null;
  return item.arguments ?? null;
}

export function itemsFromTasks(tasks: readonly Task[]): TodoSnapshot["items"] {
  const items: TodoSnapshot["items"] = [];
  for (const task of tasks) {
    if (task.status === "deleted") continue;
    const text = task.subject.trim().slice(0, TODO_TEXT_MAX_LENGTH);
    if (!text) continue;
    const activeForm = task.activeForm?.trim().slice(0, TODO_TEXT_MAX_LENGTH);
    items.push({
      id: String(task.id),
      text,
      status: task.status,
      ...(activeForm ? { activeForm } : {}),
    });
  }
  return items;
}

/** Only server-stored events are needed; sleeping checkout hosts are never queried. */
export function createTodoReader(bb: BbPluginApi) {
  const cache = new Map<string, { state: TaskState; cursor?: { seq: number; id: string } }>();
  const inFlight = new Map<string, { promise: Promise<TodoSnapshot>; dirty: boolean }>();
  function remember(threadId: string, state: TaskState, cursor?: { seq: number; id: string }) {
    cache.delete(threadId);
    cache.set(threadId, { state, cursor });
    if (cache.size > 64) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
  }
  async function read(threadId: string): Promise<TodoSnapshot> {
    const previous = cache.get(threadId);
    let state = previous?.state ?? { tasks: [], nextId: 1 };
    let cursor = previous?.cursor;
    let truncated = true;
    const signal = AbortSignal.timeout(10_000);
    if (cursor) {
      // Editing a message can delete/reuse sequence numbers. Validate identity,
      // not just the latest sequence, before reusing the reconstructed state.
      const anchor = await bb.sdk.threads.events.list({
        threadId,
        types: EVENT_TYPES,
        order: "desc",
        limit: "1",
        beforeSeq: String(cursor.seq + 1),
        signal,
      });
      if (anchor[0]?.id !== cursor.id || anchor[0]?.seq !== cursor.seq) {
        state = { tasks: [], nextId: 1 };
        cursor = undefined;
        cache.delete(threadId);
      }
    }
    for (let i = 0; i < MAX_PAGES; i++) {
      const page = await bb.sdk.threads.events.list({
        threadId,
        types: EVENT_TYPES,
        order: "asc",
        limit: String(PAGE_SIZE),
        ...(cursor ? { afterSeq: String(cursor.seq) } : {}),
        signal,
      });
      for (const row of page) {
        if (
          row.type === "system/operation" &&
          row.data.operation === "context_clear" &&
          row.data.status === "completed"
        ) {
          state = { tasks: [], nextId: 1 };
        } else {
          const args = todoArgsFromEvent(row);
          if (args) state = replayTodoArgs([args], state);
        }
      }
      const last = page.at(-1);
      if (last) cursor = { seq: last.seq, id: last.id };
      // Keep validated progress even if a subsequent page exceeds the deadline.
      remember(threadId, state, cursor);
      if (page.length < PAGE_SIZE) {
        truncated = false;
        break;
      }
    }
    return { items: itemsFromTasks(state.tasks), truncated };
  }
  return {
    read(threadId: string) {
      const current = inFlight.get(threadId);
      if (current) {
        // The caller may be reacting to a mutation after our last page read.
        current.dirty = true;
        return current.promise;
      }
      const entry = {
        dirty: false,
        promise: Promise.resolve<TodoSnapshot>({ items: [], truncated: false }),
      };
      entry.promise = (async () => {
        let snapshot: TodoSnapshot;
        let attempts = 0;
        do {
          entry.dirty = false;
          snapshot = await read(threadId);
          attempts++;
        } while (entry.dirty && attempts < 2);
        return entry.dirty ? { ...snapshot, truncated: true } : snapshot;
      })().finally(() => inFlight.delete(threadId));
      inFlight.set(threadId, entry);
      return entry.promise;
    },
    invalidate(threadId: string) {
      const current = inFlight.get(threadId);
      if (current) current.dirty = true;
    },
  };
}

export function registerRpivTodos(bb: BbPluginApi): void {
  const reader = createTodoReader(bb);
  bb.settings.define({
    [RPIV_TODO_EXPAND_SETTING]: {
      type: "boolean",
      label: "Expand RPIV task list when opening a thread",
      default: true,
    },
  });
  bb.rpc.register(rpivTodoContract, { getRpivTodos: ({ threadId }) => reader.read(threadId) });
  const publish = ({ thread }: { thread: { id: string } }) => {
    // A settling turn may race the last page of an already-running read.
    reader.invalidate(thread.id);
    bb.realtime.publish(RPIV_TODO_CHANNEL, { threadId: thread.id });
  };
  bb.events.on("thread.active", publish);
  bb.events.on("thread.idle", publish);
  bb.events.on("thread.failed", publish);
}
