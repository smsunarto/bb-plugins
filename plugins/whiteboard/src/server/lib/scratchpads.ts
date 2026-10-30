import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { ReviewInputError } from "../../shared/review/input-error.ts";
import { currentThread } from "./thread-context.ts";

/** Resolve the agent-facing alias at the BB boundary; persisted ids belong to one thread. */
export function createScratchpads(bb: BbPluginApi) {
  const db = bb.storage.database();
  const currentId = (): string | undefined => {
    const threadId = currentThread()?.threadId;
    if (!threadId) return undefined;
    const select = db.prepare("SELECT session_id FROM thread_scratchpads WHERE thread_id=?");
    let row = select.get(threadId) as { session_id: string } | undefined;
    if (!row) {
      db.prepare("INSERT OR IGNORE INTO thread_scratchpads(thread_id,session_id) VALUES (?,?)").run(
        threadId,
        randomUUID(),
      );
      row = select.get(threadId) as { session_id: string };
    }
    return row.session_id;
  };
  /** Reads: "scratchpad" names this thread's pad, or the legacy shared pad outside a thread. */
  const resolveId = (id: string): string => {
    if (id === "scratchpad") {
      const scoped = currentId();
      if (!scoped && db.prepare("SELECT id FROM reviews WHERE id='scratchpad'").get())
        return "scratchpad";
      if (!scoped)
        throw new ReviewInputError(
          "Open the scratchpad from a BB thread. Each thread has its own scratchpad.",
          409,
        );
      return scoped;
    }
    const owner = db
      .prepare("SELECT thread_id FROM thread_scratchpads WHERE session_id=?")
      .get(id) as { thread_id: string } | undefined;
    if (owner && owner.thread_id !== currentThread()?.threadId)
      throw new ReviewInputError(
        "This scratchpad belongs to another BB thread. Open this thread's scratchpad instead.",
        404,
      );
    return id;
  };
  /** Writes: as reads, and the legacy shared pad is read-only. */
  const writableId = (id: string): string => {
    const resolved = resolveId(id);
    if (resolved === "scratchpad")
      throw new ReviewInputError(
        "The legacy shared scratchpad is read-only. Open a BB thread to use its own scratchpad.",
        409,
      );
    return resolved;
  };
  return { currentId, resolveId, writableId };
}
