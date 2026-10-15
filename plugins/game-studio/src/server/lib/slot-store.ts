import { createHash, randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

type Db = ReturnType<BbPluginApi["storage"]["database"]>;
export type SlotState =
  | "available"
  | "preparing"
  | "leased"
  | "seeding"
  | "releasing"
  | "quarantined"
  | "retired";
export interface Slot {
  id: string;
  hostId: string;
  workspacePath: string;
  projectId: string;
  state: SlotState;
  ownerThreadId: string | null;
  leaseId: string | null;
  reason: string | null;
  updatedAt: string;
}

const table = "unity_checkout_slots";
const columns = `id, host AS hostId, workspace AS workspacePath, project AS projectId,
  state, owner AS ownerThreadId, lease AS leaseId, reason, updated AS updatedAt`;
const createTable = `CREATE TABLE IF NOT EXISTS ${table} (
  id TEXT PRIMARY KEY, host TEXT NOT NULL, workspace TEXT NOT NULL, project TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('available','preparing','leased','seeding','releasing','quarantined','retired')),
  owner TEXT, lease TEXT, reason TEXT, updated TEXT NOT NULL,
  UNIQUE(host, workspace),
  CHECK((state IN ('available','retired') AND owner IS NULL AND lease IS NULL)
    OR (state IN ('preparing','leased','seeding') AND owner IS NOT NULL AND lease IS NOT NULL)
    OR (state IN ('releasing','quarantined') AND lease IS NOT NULL))
)`;

/** Durable checkout ownership; an Editor claim protects a process inside this lease. */
export class SlotStore {
  readonly db: Db;
  constructor(db: Db) {
    this.db = db;
    db.transaction(() => {
      const previous = db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table) as { sql: string } | undefined;
      if (previous && !previous.sql.includes("'seeding'")) {
        db.exec(`ALTER TABLE ${table} RENAME TO unity_checkout_slots_legacy`);
        db.exec(createTable);
        db.exec(`INSERT INTO ${table} SELECT * FROM unity_checkout_slots_legacy`);
        db.exec("DROP TABLE unity_checkout_slots_legacy");
      } else db.exec(createTable);
      db.prepare(
        `UPDATE ${table} SET state = 'quarantined', reason = ?, updated = ? WHERE state IN ('preparing','seeding','releasing')`,
      ).run("Checkout verification was interrupted; explicit recovery is required", this.now());
    }).immediate();
  }

  list(hostId?: string): Slot[] {
    return (
      hostId
        ? this.db
            .prepare(`SELECT ${columns} FROM ${table} WHERE host = ? ORDER BY workspace`)
            .all(hostId)
        : this.db.prepare(`SELECT ${columns} FROM ${table} ORDER BY host, workspace`).all()
    ) as Slot[];
  }

  get(id: string): Slot | null {
    return (
      (this.db.prepare(`SELECT ${columns} FROM ${table} WHERE id = ?`).get(id) as Slot) ?? null
    );
  }

  find(hostId: string, workspacePath: string): Slot | null {
    return (
      (this.db
        .prepare(`SELECT ${columns} FROM ${table} WHERE host = ? AND workspace = ?`)
        .get(hostId, workspacePath) as Slot) ?? null
    );
  }

  register(hostId: string, workspacePath: string, projectId: string): Slot {
    return this.db
      .transaction(() => {
        const current = this.find(hostId, workspacePath);
        if (current) {
          this.scope(current, hostId, projectId);
          if (current.state !== "retired") return current;
          this.noEditorClaims(current);
          return this.save({ ...current, state: "available", reason: null });
        }
        const slot: Slot = {
          id: `slot-${createHash("sha256").update(`${hostId}\0${workspacePath}`).digest("hex").slice(0, 24)}`,
          hostId,
          workspacePath,
          projectId,
          state: "available",
          ownerThreadId: null,
          leaseId: null,
          reason: null,
          updatedAt: this.now(),
        };
        this.noEditorClaims(slot);
        this.db
          .prepare(
            `INSERT INTO ${table} (id, host, workspace, project, state, owner, lease, reason, updated)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            slot.id,
            slot.hostId,
            slot.workspacePath,
            slot.projectId,
            slot.state,
            slot.ownerThreadId,
            slot.leaseId,
            slot.reason,
            slot.updatedAt,
          );
        return slot;
      })
      .immediate();
  }

  acquire(id: string, hostId: string, projectId: string, ownerThreadId: string): Slot {
    return this.db
      .transaction(() => {
        const slot = this.required(id);
        this.scope(slot, hostId, projectId);
        if (slot.state === "leased" && slot.ownerThreadId === ownerThreadId) return slot;
        if (slot.state !== "available") this.unavailable(slot);
        this.noEditorClaims(slot);
        return this.save({
          ...slot,
          state: "preparing",
          ownerThreadId,
          leaseId: randomUUID(),
          reason: null,
        });
      })
      .immediate();
  }

  completeAcquire(id: string, leaseId: string): Slot {
    return this.db
      .transaction(() => {
        const slot = this.required(id);
        if (slot.leaseId !== leaseId || (slot.state !== "preparing" && slot.state !== "leased"))
          throw new Error("Checkout lease changed during preparation");
        this.noEditorClaims(slot);
        return slot.state === "leased" ? slot : this.save({ ...slot, state: "leased" });
      })
      .immediate();
  }

  beginRelease(id: string, ownerThreadId: string, leaseId: string): Slot {
    return this.db
      .transaction(() => {
        const slot = this.required(id);
        this.owned(slot, ownerThreadId, leaseId);
        if (slot.state !== "leased" && slot.state !== "releasing") this.unavailable(slot);
        this.noEditorClaims(slot);
        return slot.state === "releasing" ? slot : this.save({ ...slot, state: "releasing" });
      })
      .immediate();
  }

  /** Freeze the source even against its owner until the cache snapshot is complete. */
  beginSeed(id: string, ownerThreadId: string, leaseId: string): Slot {
    return this.db
      .transaction(() => {
        const slot = this.required(id);
        this.owned(slot, ownerThreadId, leaseId);
        if (slot.state !== "leased") this.unavailable(slot);
        this.noEditorClaims(slot);
        return this.save({ ...slot, state: "seeding" });
      })
      .immediate();
  }

  completeSeed(id: string, leaseId: string, keepLease: boolean): Slot {
    return this.db
      .transaction(() => {
        const slot = this.required(id);
        if (slot.state !== "seeding" || slot.leaseId !== leaseId)
          throw new Error("Checkout lease changed during cache seeding");
        this.noEditorClaims(slot);
        return this.save({
          ...slot,
          state: keepLease ? "leased" : "available",
          ownerThreadId: keepLease ? slot.ownerThreadId : null,
          leaseId: keepLease ? slot.leaseId : null,
        });
      })
      .immediate();
  }

  completeRelease(id: string, leaseId: string): Slot {
    return this.db
      .transaction(() => {
        const slot = this.required(id);
        if (slot.state === "available") return slot;
        this.pending(slot, leaseId);
        this.noEditorClaims(slot);
        return this.save({
          ...slot,
          state: "available",
          ownerThreadId: null,
          leaseId: null,
          reason: null,
        });
      })
      .immediate();
  }

  quarantine(id: string, leaseId: string, reason: string): Slot {
    return this.db
      .transaction(() => {
        const slot = this.required(id);
        if (
          slot.leaseId !== leaseId ||
          (slot.state !== "preparing" &&
            slot.state !== "seeding" &&
            slot.state !== "leased" &&
            slot.state !== "releasing" &&
            slot.state !== "quarantined")
        )
          throw new Error("Checkout lease changed during verification");
        return this.save({ ...slot, state: "quarantined", reason });
      })
      .immediate();
  }

  /** The caller must first validate recovery authority and then verify the host is stopped. */
  beginRecovery(id: string, expectedLeaseId: string | null): Slot {
    return this.db
      .transaction(() => {
        const slot = this.required(id);
        if (
          slot.leaseId !== expectedLeaseId ||
          (slot.state !== "leased" && slot.state !== "quarantined")
        )
          throw new Error("Checkout lease changed during recovery");
        this.noEditorClaims(slot);
        return this.save({ ...slot, state: "releasing", leaseId: randomUUID(), reason: null });
      })
      .immediate();
  }

  beginRetire(id: string, hostId: string, workspacePath: string): Slot {
    return this.db
      .transaction(() => {
        const slot = this.required(id);
        if (slot.hostId !== hostId || slot.workspacePath !== workspacePath)
          throw new Error("Checkout host or path does not match its registration");
        if (slot.state === "retired") return slot;
        if (slot.state === "releasing" && slot.ownerThreadId === null) return slot;
        if (slot.state !== "available") this.unavailable(slot);
        this.noEditorClaims(slot);
        return this.save({ ...slot, state: "releasing", leaseId: randomUUID(), reason: null });
      })
      .immediate();
  }

  completeRetire(id: string, leaseId: string): Slot {
    return this.db
      .transaction(() => {
        const slot = this.required(id);
        if (slot.state === "retired") return slot;
        this.pending(slot, leaseId);
        if (slot.ownerThreadId !== null) throw new Error("Checkout is being released by its owner");
        this.noEditorClaims(slot);
        return this.save({
          ...slot,
          state: "retired",
          ownerThreadId: null,
          leaseId: null,
          reason: null,
        });
      })
      .immediate();
  }

  /** Call inside the Editor claim's immediate transaction. */
  editorAccess(hostId: string, workspacePath: string, ownerThreadId: string): void {
    const slot = this.find(hostId, workspacePath);
    if (slot && (slot.state !== "leased" || slot.ownerThreadId !== ownerThreadId))
      this.unavailable(slot);
  }

  private required(id: string): Slot {
    const slot = this.get(id);
    if (!slot) throw new Error("Registered checkout slot was not found");
    return slot;
  }

  private scope(slot: Slot, hostId: string, projectId: string) {
    if (slot.hostId !== hostId || slot.projectId !== projectId)
      throw new Error("Checkout host or BB project does not match its registration");
  }

  private owned(slot: Slot, ownerThreadId: string, leaseId: string) {
    if (slot.ownerThreadId !== ownerThreadId || slot.leaseId !== leaseId)
      throw new Error("A matching checkout lease owned by this BB thread is required");
  }

  private pending(slot: Slot, leaseId: string) {
    if (slot.state !== "releasing" || slot.leaseId !== leaseId)
      throw new Error("Checkout lease changed during verification");
  }

  private unavailable(slot: Slot): never {
    throw new Error(
      slot.ownerThreadId
        ? `Checkout is ${slot.state} by @thread:${slot.ownerThreadId}`
        : `Checkout is ${slot.state}; acquire an available slot lease first`,
    );
  }

  private noEditorClaims(slot: Slot) {
    const exists = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'unity_editor_claims'")
      .get();
    if (
      exists &&
      this.db
        .prepare("SELECT 1 FROM unity_editor_claims WHERE host = ? AND workspace = ? LIMIT 1")
        .get(slot.hostId, slot.workspacePath)
    )
      throw new Error("Release all Editor claims for this checkout first");
  }

  private save(slot: Slot): Slot {
    const updated = { ...slot, updatedAt: this.now() };
    this.db
      .prepare(
        `UPDATE ${table} SET state = ?, owner = ?, lease = ?, reason = ?, updated = ? WHERE id = ?`,
      )
      .run(
        updated.state,
        updated.ownerThreadId,
        updated.leaseId,
        updated.reason,
        updated.updatedAt,
        updated.id,
      );
    return updated;
  }

  private now() {
    return new Date().toISOString();
  }
}
