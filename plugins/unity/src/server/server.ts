import { instructionFiles } from "@bb-kit/core/instructions";
import { definePlugin } from "@bb-kit/core/plugin";
import { manage as manageCommand } from "./command/manage.ts";
import { manage as manageTool } from "./tools/manage.ts";
import { createUnityEditors } from "./lib/unity-editors.ts";
import { listUnityEditors } from "./rpc/list-unity-editors.ts";
import { legacyClaimsGuard } from "./lib/legacy-claims.ts";
import { slots as slotsCommand } from "./command/slots.ts";
import { slots as slotsTool } from "./tools/slots.ts";
import { SlotStore } from "./lib/slot-store.ts";
import { UnitySlots } from "./lib/unity-slots.ts";

export default definePlugin({
  pluginId: "unity",
  rpc: { listUnityEditors },
  rpcPublication: {
    discoverable: true,
    description: "Unity Editor discovery, checkout slots and public ownership information.",
  },
  command: { manage: manageCommand, slots: slotsCommand },
  services(bb) {
    const slotStore = new SlotStore(bb.storage.database());
    const unityEditors = createUnityEditors(bb, slotStore);
    const ensureLegacyClaims = legacyClaimsGuard(bb, unityEditors.claims.db);
    return {
      unityEditors,
      unitySlots: new UnitySlots(bb, slotStore, ensureLegacyClaims),
      ensureLegacyClaims,
    };
  },
  setup({ unitySlots }) {
    unitySlots.install();
  },
  agents: {
    files: instructionFiles(import.meta.url),
    tools: { manage: manageTool, slots: slotsTool },
    skills: ["unity-editors"],
  },
});
