import { randomBytes } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

/** Published pages, kept in the plugin's database on the bb server. */

const MIGRATIONS = [
  `CREATE TABLE pages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    title TEXT NOT NULL,
    height INTEGER NOT NULL,
    html TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX pages_thread ON pages (thread_id)`,
];

export interface PageStore {
  save(page: { threadId: string; title: string; height: number; html: string }): string;
  html(id: string): string | undefined;
  deleteThread(threadId: string): void;
}

export function createPageStore(bb: BbPluginApi): PageStore {
  const database = bb.storage.database();
  bb.storage.migrate(database, MIGRATIONS);
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
