import { createHash } from "node:crypto";
import type {
  CheckoutSlot,
  EditorInstance,
  VisibleEditorClaim,
} from "../../shared/unity-editor-contract.ts";

/** Host discovery canonicalizes Assets to the shared checkout, including MPPM clones. */
export function checkoutSlots(
  hostId: string,
  instances: EditorInstance[],
  claims: VisibleEditorClaim[],
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
  for (const slot of slots.values()) {
    slot.mainEditors.sort((a, b) => a.id.localeCompare(b.id));
    slot.mppmEditors.sort((a, b) => a.id.localeCompare(b.id));
    slot.claims.sort((a, b) => a.instance.id.localeCompare(b.instance.id));
  }
  return [...slots.values()].sort((a, b) => a.workspacePath.localeCompare(b.workspacePath));
}
