import { createHash } from "node:crypto";
import type { z } from "zod";
import type { slotSchema } from "../../shared/slot-contract.ts";
import type {
  CheckoutSlot,
  EditorInstance,
  EditorReservation,
  VisibleEditorClaim,
} from "../../shared/unity-editor-contract.ts";

/** Host discovery canonicalizes Assets to the shared checkout, including MPPM clones. */
export function checkoutSlots(
  hostId: string,
  instances: EditorInstance[],
  claims: VisibleEditorClaim[],
  registered: z.infer<typeof slotSchema>[] = [],
  reservations: EditorReservation[] = [],
): CheckoutSlot[] {
  const slots = new Map<string, CheckoutSlot>();
  const slotFor = (workspacePath: string) => {
    let slot = slots.get(workspacePath);
    if (!slot) {
      slot = {
        id: `slot-${createHash("sha256")
          .update(`${hostId}\0${workspacePath}`)
          .digest("hex")
          .slice(0, 24)}`,
        hostId,
        workspacePath,
        mainEditors: [],
        mppmEditors: [],
        claims: [],
        reservations: [],
      };
      slots.set(workspacePath, slot);
    }
    return slot;
  };
  for (const instance of instances) {
    const slot = slotFor(instance.workspacePath);
    (instance.clone ? slot.mppmEditors : slot.mainEditors).push(instance);
  }
  // An undiscovered Editor's durable claim still occupies its checkout until recovery.
  for (const claim of claims) slotFor(claim.instance.workspacePath).claims.push(claim);
  // A reservation occupies a checkout whose Editor is still starting.
  for (const reservation of reservations)
    slotFor(reservation.workspacePath).reservations.push(reservation);
  for (const slot of registered) slotFor(slot.workspacePath).lifecycle = slot;
  for (const slot of slots.values()) {
    slot.mainEditors.sort((a, b) => a.id.localeCompare(b.id));
    slot.mppmEditors.sort((a, b) => a.id.localeCompare(b.id));
    slot.claims.sort((a, b) => a.instance.id.localeCompare(b.instance.id));
  }
  return [...slots.values()].sort((a, b) => a.workspacePath.localeCompare(b.workspacePath));
}
