import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Reminder, SaveInput } from "../../shared/reminder.ts";

export function openStore(bb: Pick<BbPluginApi, "storage">) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE reminders (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      sourceThreadId TEXT,
      createdAt TEXT NOT NULL
    )`,
  ]);
  const get = (id: string) =>
    db.prepare<[string], Reminder>("SELECT * FROM reminders WHERE id = ?").get(id) ?? null;
  return {
    get,
    list: () =>
      db.prepare<[], Reminder>("SELECT * FROM reminders ORDER BY createdAt DESC, id DESC").all(),
    save: db.transaction((input: SaveInput): Reminder => {
      const existing = get(input.id);
      if (existing) {
        if (
          existing.title !== input.title ||
          existing.body !== input.body ||
          existing.sourceThreadId !== input.sourceThreadId
        ) {
          throw new Error("This reminder ID is already used for different content. Use a new ID.");
        }
        return existing;
      }
      const reminder = { ...input, createdAt: new Date().toISOString() };
      db.prepare(
        "INSERT INTO reminders (id, title, body, sourceThreadId, createdAt) VALUES (@id, @title, @body, @sourceThreadId, @createdAt)",
      ).run(reminder);
      return reminder;
    }),
  };
}

export type ReminderStore = ReturnType<typeof openStore>;
