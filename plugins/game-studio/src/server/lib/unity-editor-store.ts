import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { EditorInstance, EditorReservation } from "../../shared/unity-editor-contract.ts";
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
  /** Kept across the owner's idle turns; otherwise the claim releases itself at turn end. */
  hold?: boolean;
  /** The owner's turn ended while the Editor was busy; release retries until it is quiet. */
  autoRelease?: "pending";
  /** What the last release attempt found: playing, dirty scenes, or a background status. */
  autoReleaseBlock?: string;
}
export interface ClaimOptions {
  hold?: boolean;
}
/** Another thread holds the Editor, its shared checkout, or a reservation on it. */
export class ClaimConflictError extends Error {
  readonly owner: string;
  readonly holder: EditorClaim | EditorReservation;
  constructor(message: string, holder: EditorClaim | EditorReservation) {
    super(message);
    this.name = "ClaimConflictError";
    this.owner = holder.ownerThreadId;
    this.holder = holder;
  }
}
type Db = ReturnType<BbPluginApi["storage"]["database"]>;
const table = "unity_editor_claims";
const reservationTable = "unity_editor_reservations";
/** Runtime claims coexist; an authoring claim excludes every other thread on the checkout. */
function excludes(mode: EditorMode, other: EditorMode) {
  return mode === "authoring" || other === "authoring";
}
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
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${reservationTable} (key TEXT PRIMARY KEY, host TEXT NOT NULL, workspace TEXT NOT NULL, record TEXT NOT NULL)`,
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
        for (const claim of this.ownedBy(owner)) this.save({ ...claim, orphaned });
      })
      .immediate();
  }
  list(hostId: string): EditorClaim[] {
    return this.db
      .prepare(`SELECT record FROM ${table} WHERE host = ?`)
      .all(hostId)
      .map((row: any) => JSON.parse(row.record));
  }
  /** Every claim on every host. */
  all(): EditorClaim[] {
    return (this.db.prepare(`SELECT record FROM ${table}`).all() as { record: string }[]).map(
      (row) => JSON.parse(row.record) as EditorClaim,
    );
  }
  /** One thread's claims on every host, for turn-end release. */
  ownedBy(owner: string): EditorClaim[] {
    return this.all().filter((claim) => claim.ownerThreadId === owner);
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
  /** Claim ids are unguessable, so a caller's claim id alone identifies its Editor. */
  byClaimId(hostId: string, claimId: string): EditorClaim | null {
    return this.list(hostId).find((claim) => claim.claimId === claimId) ?? null;
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
  /** The other thread whose claim on this checkout excludes `mode`, if any. */
  private claimConflict(hostId: string, workspacePath: string, owner: string, mode: EditorMode) {
    return this.list(hostId).find(
      (c) =>
        c.instance.workspacePath === workspacePath &&
        c.ownerThreadId !== owner &&
        excludes(mode, c.mode),
    );
  }
  claim(
    hostId: string,
    instance: EditorInstance,
    ownerThreadId: string,
    mode: EditorMode,
    options: ClaimOptions = {},
  ): { claim: EditorClaim; created: boolean } {
    return this.db
      .transaction(() => {
        this.slots?.editorAccess(hostId, instance.workspacePath, ownerThreadId);
        const current = this.get(hostId, instance.id);
        if (current) {
          if (current.ownerThreadId !== ownerThreadId)
            throw new ClaimConflictError(
              `Editor is owned by @thread:${current.ownerThreadId}`,
              current,
            );
          if (current.mode !== mode)
            throw new Error("Release the existing claim before changing its mode");
          if (options.hold !== undefined && Boolean(current.hold) !== options.hold) {
            const updated = { ...current, hold: options.hold || undefined };
            this.save(updated);
            return { claim: updated, created: false };
          }
          return { claim: current, created: false };
        }
        if (instance.clone && mode === "authoring")
          throw new Error("Additional MPPM Editors cannot author scenes or shared assets");
        const conflict = this.claimConflict(hostId, instance.workspacePath, ownerThreadId, mode);
        if (conflict)
          throw new ClaimConflictError(
            `Shared project is owned by @thread:${conflict.ownerThreadId}`,
            conflict,
          );
        const reservation = this.reservationFor(hostId, instance.workspacePath);
        // A reservation stands for the main Editor being opened: only MPPM clients may share it.
        if (
          reservation &&
          reservation.ownerThreadId !== ownerThreadId &&
          (!instance.clone || excludes(mode, reservation.mode))
        )
          throw new ClaimConflictError(
            `Workspace is reserved by @thread:${reservation.ownerThreadId}, which is opening its Editor`,
            reservation,
          );
        const mine = reservation?.ownerThreadId === ownerThreadId ? reservation : null;
        if (mine) this.deleteReservation(hostId, instance.workspacePath);
        const hold = options.hold ?? mine?.hold;
        const claim: EditorClaim = {
          instance,
          hostId,
          ownerThreadId,
          mode,
          claimId: randomUUID(),
          jobId: "verifying",
          operationLoadId: this.loadId,
          claimedAt: new Date().toISOString(),
          ...(hold ? { hold: true } : {}),
        };
        this.save(claim);
        return { claim, created: true };
      })
      .immediate();
  }
  promote(hostId: string, id: string, owner: string, claimId: string, instance: EditorInstance) {
    return this.db
      .transaction(() => {
        const claim = this.owned(hostId, id, owner, claimId);
        if (
          claim.jobId !== "verifying" ||
          claim.instance.port !== null ||
          instance.port === null ||
          instance.id !== id ||
          instance.pid !== claim.instance.pid ||
          instance.startedAt !== claim.instance.startedAt ||
          instance.projectPath !== claim.instance.projectPath ||
          instance.workspacePath !== claim.instance.workspacePath
        )
          throw new Error("Startup promotion must preserve the verified Editor identity");
        const updated = { ...claim, instance };
        this.save(updated);
        return updated;
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
  /** Record whether a busy Editor's claim is still waiting to release itself, and why. */
  autoRelease(
    hostId: string,
    id: string,
    owner: string,
    claimId: string,
    pending: boolean,
    block?: string,
  ) {
    return this.db
      .transaction(() => {
        const claim = this.owned(hostId, id, owner, claimId);
        const { autoRelease: _autoRelease, autoReleaseBlock: _block, ...rest } = claim;
        const updated: EditorClaim = pending
          ? { ...rest, autoRelease: "pending", ...(block ? { autoReleaseBlock: block } : {}) }
          : rest;
        this.save(updated);
        return updated;
      })
      .immediate();
  }
  /** Whatever stops `owner` from claiming `instance` in `mode`: an exact claim, a checkout claim, or a reservation. */
  blockerFor(
    hostId: string,
    instance: EditorInstance,
    owner: string,
    mode: EditorMode,
  ): EditorClaim | EditorReservation | null {
    const current = this.get(hostId, instance.id);
    if (current && current.ownerThreadId !== owner) return current;
    const conflict = this.claimConflict(hostId, instance.workspacePath, owner, mode);
    if (conflict) return conflict;
    const reservation = this.reservationFor(hostId, instance.workspacePath);
    if (
      reservation &&
      reservation.ownerThreadId !== owner &&
      (!instance.clone || excludes(mode, reservation.mode))
    )
      return reservation;
    return null;
  }
  /** Whatever stops `owner` from reserving `workspacePath` in `mode`. */
  workspaceBlocker(
    hostId: string,
    workspacePath: string,
    owner: string,
    mode: EditorMode,
  ): EditorClaim | EditorReservation | null {
    const reservation = this.reservationFor(hostId, workspacePath);
    if (reservation && reservation.ownerThreadId !== owner) return reservation;
    return this.claimConflict(hostId, workspacePath, owner, mode) ?? null;
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
  reservations(hostId?: string): EditorReservation[] {
    const rows = (
      hostId
        ? this.db.prepare(`SELECT record FROM ${reservationTable} WHERE host = ?`).all(hostId)
        : this.db.prepare(`SELECT record FROM ${reservationTable}`).all()
    ) as { record: string }[];
    return rows
      .map((row) => JSON.parse(row.record) as EditorReservation)
      .sort((a, b) => a.workspacePath.localeCompare(b.workspacePath));
  }
  reservationFor(hostId: string, workspacePath: string): EditorReservation | null {
    const row = this.db
      .prepare(`SELECT record FROM ${reservationTable} WHERE key = ?`)
      .get(this.key(hostId, workspacePath)) as { record: string } | undefined;
    return row ? JSON.parse(row.record) : null;
  }
  reservationsBy(owner: string): EditorReservation[] {
    return this.reservations().filter((reservation) => reservation.ownerThreadId === owner);
  }
  /** Hold a checkout for the Editor this thread is about to open. */
  reserve(
    hostId: string,
    workspacePath: string,
    ownerThreadId: string,
    mode: EditorMode,
    hold?: boolean,
  ): EditorReservation {
    return this.db
      .transaction(() => {
        this.slots?.editorAccess(hostId, workspacePath, ownerThreadId);
        const existing = this.reservationFor(hostId, workspacePath);
        if (existing && existing.ownerThreadId !== ownerThreadId)
          throw new ClaimConflictError(
            `Workspace is reserved by @thread:${existing.ownerThreadId}, which is opening its Editor`,
            existing,
          );
        const conflict = this.claimConflict(hostId, workspacePath, ownerThreadId, mode);
        if (conflict)
          throw new ClaimConflictError(
            `Shared project is owned by @thread:${conflict.ownerThreadId}`,
            conflict,
          );
        const reservation: EditorReservation = {
          hostId,
          workspacePath,
          ownerThreadId,
          mode,
          ...((hold ?? existing?.hold) ? { hold: true } : {}),
          reservedAt: existing?.reservedAt ?? new Date().toISOString(),
        };
        this.db
          .prepare(
            `INSERT INTO ${reservationTable} (key, host, workspace, record) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET record=excluded.record`,
          )
          .run(this.key(hostId, workspacePath), hostId, workspacePath, JSON.stringify(reservation));
        return reservation;
      })
      .immediate();
  }
  /** Returns false when nothing was reserved. */
  releaseReservation(hostId: string, workspacePath: string, ownerThreadId: string): boolean {
    return this.db
      .transaction(() => {
        const existing = this.reservationFor(hostId, workspacePath);
        if (!existing) return false;
        if (existing.ownerThreadId !== ownerThreadId)
          throw new ClaimConflictError(
            `Workspace is reserved by @thread:${existing.ownerThreadId}`,
            existing,
          );
        this.deleteReservation(hostId, workspacePath);
        return true;
      })
      .immediate();
  }
  /** A deleted or archived owner will never open its Editor; drop its reservations, held or not. */
  releaseReservationsOf(owner: string): number {
    return this.db
      .transaction(() => {
        const mine = this.reservationsBy(owner);
        for (const reservation of mine)
          this.deleteReservation(reservation.hostId, reservation.workspacePath);
        return mine.length;
      })
      .immediate();
  }
  /** Remove a reservation whose owner the caller has proven absent. */
  recoverReservation(hostId: string, workspacePath: string): EditorReservation | null {
    return this.db
      .transaction(() => {
        const existing = this.reservationFor(hostId, workspacePath);
        if (existing) this.deleteReservation(hostId, workspacePath);
        return existing;
      })
      .immediate();
  }
  private deleteReservation(hostId: string, workspacePath: string) {
    this.db
      .prepare(`DELETE FROM ${reservationTable} WHERE key = ?`)
      .run(this.key(hostId, workspacePath));
  }
}
