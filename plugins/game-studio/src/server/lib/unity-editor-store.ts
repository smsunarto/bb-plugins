import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { EditorInstance } from "../../shared/unity-editor-contract.ts";
import type { SlotStore } from "./slot-store.ts";

export type EditorMode = "runtime" | "authoring";
export interface EditorClaim {
  instance: EditorInstance;
  hostId: string;
  ownerThreadId: string;
  claimId: string;
  mode: EditorMode;
  jobId: string | null;
  claimedAt: string;
  operationLoadId?: string;
  orphaned?: boolean;
}
type Db = ReturnType<BbPluginApi["storage"]["database"]>;
const table = "unity_editor_claims";
export class EditorClaims {
  private readonly loadId = randomUUID();
  readonly db: Db;
  readonly slots: SlotStore | undefined;
  constructor(db: Db, slots?: SlotStore) {
    this.db = db;
    this.slots = slots;
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${table} (key TEXT PRIMARY KEY, host TEXT NOT NULL, workspace TEXT NOT NULL, record TEXT NOT NULL)`,
    );
    db.transaction(() => {
      for (const row of db.prepare(`SELECT record FROM ${table}`).all() as { record: string }[]) {
        const claim: EditorClaim = JSON.parse(row.record);
        if (claim.operationLoadId === this.loadId) continue;
        if (claim.jobId === "verifying") {
          db.prepare(`DELETE FROM ${table} WHERE key = ?`).run(
            this.key(claim.hostId, claim.instance.id),
          );
        } else if (claim.jobId === "submitting") this.save({ ...claim, jobId: "uncertain" });
      }
    }).immediate();
  }
  markOrphan(owner: string, orphaned = true) {
    this.db
      .transaction(() => {
        for (const row of this.db.prepare(`SELECT record FROM ${table}`).all() as {
          record: string;
        }[]) {
          const claim: EditorClaim = JSON.parse(row.record);
          if (claim.ownerThreadId === owner) this.save({ ...claim, orphaned });
        }
      })
      .immediate();
  }
  list(hostId: string): EditorClaim[] {
    return this.db
      .prepare(`SELECT record FROM ${table} WHERE host = ?`)
      .all(hostId)
      .map((row: any) => JSON.parse(row.record));
  }
  private key(hostId: string, id: string) {
    return `${hostId}:${id}`;
  }
  get(hostId: string, id: string): EditorClaim | null {
    const row = this.db
      .prepare(`SELECT record FROM ${table} WHERE key = ?`)
      .get(this.key(hostId, id)) as { record: string } | undefined;
    return row ? JSON.parse(row.record) : null;
  }
  private save(claim: EditorClaim) {
    this.db
      .prepare(
        `INSERT INTO ${table} (key, host, workspace, record) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET record=excluded.record`,
      )
      .run(
        this.key(claim.hostId, claim.instance.id),
        claim.hostId,
        claim.instance.workspacePath,
        JSON.stringify(claim),
      );
  }
  claim(
    hostId: string,
    instance: EditorInstance,
    ownerThreadId: string,
    mode: EditorMode,
  ): { claim: EditorClaim; created: boolean } {
    return this.db
      .transaction(() => {
        this.slots?.editorAccess(hostId, instance.workspacePath, ownerThreadId);
        const current = this.get(hostId, instance.id);
        if (current) {
          if (current.ownerThreadId !== ownerThreadId)
            throw new Error(`Editor is owned by @thread:${current.ownerThreadId}`);
          if (current.mode !== mode)
            throw new Error("Release the existing claim before changing its mode");
          return { claim: current, created: false };
        }
        if (instance.clone && mode === "authoring")
          throw new Error("Additional MPPM Editors cannot author scenes or shared assets");
        const conflict = this.list(hostId).find(
          (c) =>
            c.instance.workspacePath === instance.workspacePath &&
            c.ownerThreadId !== ownerThreadId &&
            (mode === "authoring" || c.mode === "authoring"),
        );
        if (conflict)
          throw new Error(`Shared project is owned by @thread:${conflict.ownerThreadId}`);
        const claim: EditorClaim = {
          instance,
          hostId,
          ownerThreadId,
          mode,
          claimId: randomUUID(),
          jobId: "verifying",
          operationLoadId: this.loadId,
          claimedAt: new Date().toISOString(),
        };
        this.save(claim);
        return { claim, created: true };
      })
      .immediate();
  }
  owned(hostId: string, id: string, owner: string, claimId: string): EditorClaim {
    const claim = this.get(hostId, id);
    if (!claim || claim.ownerThreadId !== owner || claim.claimId !== claimId)
      throw new Error("A matching claim owned by this BB thread is required");
    return claim;
  }
  job(
    hostId: string,
    id: string,
    owner: string,
    claimId: string,
    next: string | null,
    expected?: string | null,
  ): EditorClaim {
    return this.db
      .transaction(() => {
        const claim = this.owned(hostId, id, owner, claimId);
        if (expected !== undefined && claim.jobId !== expected) return claim;
        const updated = { ...claim, jobId: next };
        this.save(updated);
        return updated;
      })
      .immediate();
  }
  begin(hostId: string, id: string, owner: string, claimId: string): EditorClaim {
    return this.db
      .transaction(() => {
        const claim = this.owned(hostId, id, owner, claimId);
        if (claim.jobId)
          throw new Error(
            "An Editor operation is pending. Check its status before another command or release.",
          );
        this.slots?.editorAccess(hostId, claim.instance.workspacePath, owner);
        this.save({ ...claim, jobId: "submitting", operationLoadId: this.loadId });
        return claim;
      })
      .immediate();
  }
  release(hostId: string, id: string, owner: string, claimId: string): void {
    this.db
      .transaction(() => {
        const claim = this.get(hostId, id);
        if (!claim) return;
        this.owned(hostId, id, owner, claimId);
        if (claim.jobId) throw new Error("Cannot release an Editor with pending or uncertain work");
        this.db.prepare(`DELETE FROM ${table} WHERE key = ?`).run(this.key(hostId, id));
      })
      .immediate();
  }
  recover(
    hostId: string,
    id: string,
    claimId: string,
    expectedJob?: string | null,
    requireOrphan = false,
  ) {
    this.db
      .transaction(() => {
        const claim = this.get(hostId, id);
        if (
          (requireOrphan && !claim?.orphaned) ||
          claim?.claimId !== claimId ||
          (expectedJob !== undefined && claim.jobId !== expectedJob)
        )
          throw new Error("Claim changed during recovery");
        this.db.prepare(`DELETE FROM ${table} WHERE key = ?`).run(this.key(hostId, id));
      })
      .immediate();
  }
}
