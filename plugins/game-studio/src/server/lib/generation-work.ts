import type { SlotStore } from "./slot-store.ts";

/** A submission reserves the checkout before dispatch, including an uncertain host response. */
export class GenerationWork {
  private readonly slots: SlotStore;
  constructor(slots: SlotStore) {
    this.slots = slots;
    slots.db.exec(`CREATE TABLE IF NOT EXISTS studio_generation_work (
      host TEXT NOT NULL, workspace TEXT NOT NULL, job TEXT NOT NULL, owner TEXT NOT NULL,
      PRIMARY KEY (host, workspace, job))`);
  }
  reserve(host: string, workspace: string, job: string, owner: string) {
    return this.slots.db
      .transaction(() => {
        this.slots.editorAccess(host, workspace, owner);
        const existing = this.slots.db
          .prepare(
            "SELECT owner FROM studio_generation_work WHERE host = ? AND workspace = ? AND job = ?",
          )
          .get(host, workspace, job) as { owner: string } | undefined;
        if (existing && existing.owner !== owner)
          throw new Error("This generation request belongs to another thread.");
        return (
          this.slots.db
            .prepare(
              "INSERT OR IGNORE INTO studio_generation_work (host, workspace, job, owner) VALUES (?, ?, ?, ?)",
            )
            .run(host, workspace, job, owner).changes !== 0
        );
      })
      .immediate();
  }
  owner(host: string, workspace: string, job: string): string | null {
    const row = this.slots.db
      .prepare(
        "SELECT owner FROM studio_generation_work WHERE host = ? AND workspace = ? AND job = ?",
      )
      .get(host, workspace, job) as { owner: string } | undefined;
    return row?.owner ?? null;
  }
  settled(host: string, workspace: string, job: string) {
    this.slots.db
      .prepare("DELETE FROM studio_generation_work WHERE host = ? AND workspace = ? AND job = ?")
      .run(host, workspace, job);
  }
}
