import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { API_PREFIX } from "../../shared/contracts/api-tunnel.ts";
import { ReviewInputError } from "../../shared/vendor/review/src/review-api/input-error.ts";
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
  const resolve = (id: string): string => {
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
  const writable = (id: string): string => {
    const resolved = resolve(id);
    if (resolved === "scratchpad")
      throw new ReviewInputError(
        "The legacy shared scratchpad is read-only. Open a BB thread to use its own scratchpad.",
        409,
      );
    return resolved;
  };
  const rewriteSubscriptions = (parsed: URL) => {
    if (parsed.pathname !== `${API_PREFIX}/watch` || !parsed.searchParams.has("subscriptions"))
      return;
    let subscriptions;
    try {
      subscriptions = JSON.parse(parsed.searchParams.get("subscriptions")!);
    } catch {
      return;
    }
    if (Array.isArray(subscriptions)) {
      for (const item of subscriptions) {
        if (item && typeof item.reviewId === "string") item.reviewId = resolve(item.reviewId);
      }
      parsed.searchParams.set("subscriptions", JSON.stringify(subscriptions));
    }
  };
  const request = (url: string, init?: RequestInit): { url: string; init?: RequestInit } => {
    const parsed = new URL(url);
    const segments = parsed.pathname.slice(API_PREFIX.length).split("/");
    if (segments[1]) {
      const id = decodeURIComponent(segments[1]);
      const resolved = init?.method === "POST" ? writable(id) : resolve(id);
      if (resolved !== id) {
        segments[1] = encodeURIComponent(resolved);
        parsed.pathname = `${API_PREFIX}${segments.join("/")}`;
      }
    }
    rewriteSubscriptions(parsed);
    if (parsed.pathname === `${API_PREFIX}/commands` && typeof init?.body === "string") {
      let body;
      try {
        body = JSON.parse(init.body);
      } catch {
        return { url: parsed.href, init };
      }
      // Upstream owns command validation; only the session identity is translated here.
      if (
        body &&
        typeof body === "object" &&
        body.operation &&
        typeof body.operation.reviewId === "string"
      ) {
        body.operation.reviewId = writable(body.operation.reviewId);
        return { url: parsed.href, init: { ...init, body: JSON.stringify(body) } };
      }
    }
    return { url: parsed.href, init };
  };
  return { currentId, resolve, request };
}
