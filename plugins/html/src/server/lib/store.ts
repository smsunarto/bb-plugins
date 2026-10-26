import { randomBytes } from "node:crypto";
import type { Database } from "./database.ts";

/** Published pages, kept in the plugin's database on the bb server. */

export interface PageStore {
  save(page: { threadId: string; title: string; height: number; html: string }): string;
  html(id: string): string | undefined;
  deleteThread(threadId: string): void;
}

export function createPageStore(database: Database): PageStore {
  const insert = database.prepare(
    "INSERT INTO pages (id, thread_id, title, height, html, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const select = database.prepare("SELECT html FROM pages WHERE id = ?");
  const removeThread = database.prepare("DELETE FROM pages WHERE thread_id = ?");
  return {
    save({ threadId, title, height, html }) {
      // Unguessable, because any bb client that knows the id can load the page.
      const id = randomBytes(18).toString("base64url");
      insert.run(id, threadId, title, height, html, Date.now());
      return id;
    },
    html(id) {
      const row = select.get(id) as { html: string } | undefined;
      return row?.html;
    },
    deleteThread(threadId) {
      removeThread.run(threadId);
    },
  };
}
