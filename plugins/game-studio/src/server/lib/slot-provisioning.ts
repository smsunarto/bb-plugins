import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { slotProvisionResult } from "../../shared/slot-contract.ts";
import { unityHostContract } from "../../shared/unity-editor-contract.ts";
import { UnitySlots, visibleSlot } from "./unity-slots.ts";
import type { Slot } from "./slot-store.ts";

/** First creation seeds a warm checkout; subsequent calls preserve that slot's state. */
export class SlotProvisioning {
  private readonly host;
  private readonly db;
  private readonly slots: UnitySlots;
  constructor(bb: BbPluginApi, slots: UnitySlots) {
    this.slots = slots;
    this.host = bb.hosts.experimental_client({ contract: unityHostContract });
    this.db = slots.store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS unity_slot_seeds (
      operation TEXT PRIMARY KEY, slot TEXT NOT NULL, result TEXT NOT NULL
    )`);
  }

  async create(
    hostId: string,
    sourceId: string,
    path: string,
    branch: string,
    owner: string,
    signal?: AbortSignal,
  ) {
    const source = this.slots.required(sourceId, hostId);
    const operationId = createHash("sha256")
      .update(JSON.stringify([hostId, source.projectId, source.id, path, branch]))
      .digest("hex");
    const receipt = this.db
      .prepare("SELECT slot, result FROM unity_slot_seeds WHERE operation = ?")
      .get(operationId) as { slot: string; result: string } | undefined;
    if (receipt) {
      const slot = this.slots.required(receipt.slot, hostId);
      return {
        slot: visibleSlot(slot, owner),
        ...slotProvisionResult.parse(JSON.parse(receipt.result)),
      };
    }

    const planned = await this.host.call("planSlotDestination", { path }, { hostId, signal });
    if (this.slots.store.find(hostId, planned.workspacePath))
      throw new Error("The destination is already registered; reuse its slot instead");
    const previouslyOwned = source.state === "leased" && source.ownerThreadId === owner;
    const lease = await this.slots.acquire(source.id, hostId, source.projectId, owner, signal);
    this.slots.store.beginSeed(source.id, owner, lease.leaseId!);
    let target: Slot | undefined;
    try {
      target = this.db
        .transaction(() => {
          if (this.slots.store.find(hostId, planned.workspacePath))
            throw new Error("The destination was registered by another operation");
          const registered = this.slots.store.register(
            hostId,
            planned.workspacePath,
            source.projectId,
          );
          return this.slots.store.acquire(registered.id, hostId, source.projectId, owner);
        })
        .immediate();
      // Even an existing owner must close Unity before its Library can be seeded.
      await this.slots.verifyStopped(lease, owner, signal);
      const result = await this.host.call(
        "provisionSlot",
        {
          sourcePath: source.workspacePath,
          path: planned.workspacePath,
          branch,
          operationId,
        },
        { hostId, signal, timeoutMs: 30 * 60 * 1000 },
      );
      if (result.workspacePath !== target.workspacePath)
        throw new Error("Provisioning returned a different checkout than its reservation");
      await this.slots.verifyStopped(target, owner, signal);
      await this.slots.verifyStopped(lease, owner, signal);
      const reservation = target;
      const slot = this.db
        .transaction(() => {
          this.slots.store.completeAcquire(reservation.id, reservation.leaseId!);
          this.slots.store.beginRelease(reservation.id, owner, reservation.leaseId!);
          const ready = this.slots.store.completeRelease(reservation.id, reservation.leaseId!);
          this.slots.store.completeSeed(source.id, lease.leaseId!, previouslyOwned);
          this.db
            .prepare(
              "INSERT INTO unity_slot_seeds (operation, slot, result) VALUES (?, ?, ?) ON CONFLICT(operation) DO NOTHING",
            )
            .run(operationId, ready.id, JSON.stringify(result));
          return ready;
        })
        .immediate();
      return { slot: visibleSlot(slot, owner), ...result };
    } catch (error) {
      // A disconnected request can still have native work in flight. Explicit recovery
      // keeps the source unavailable until the caller has checked the host receipt.
      const current = this.slots.store.get(source.id);
      if (target?.leaseId)
        this.slots.store.quarantine(
          target.id,
          target.leaseId,
          error instanceof Error ? error.message : String(error),
        );
      if (current?.leaseId === lease.leaseId && current.state !== "available")
        this.slots.store.quarantine(
          source.id,
          lease.leaseId!,
          error instanceof Error ? error.message : String(error),
        );
      throw error;
    }
  }
}
