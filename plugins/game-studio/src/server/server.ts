import { instructionFiles } from "@bb-kit/core/instructions";
import { manage as manageCommand } from "./command/manage.ts";
import { manage as manageTool } from "./tools/manage.ts";
import { createUnityEditors } from "./lib/unity-editors.ts";
import { listUnityEditors } from "./rpc/list-unity-editors.ts";
import { legacyClaimsGuard } from "./lib/legacy-claims.ts";
import { slots as slotsCommand } from "./command/slots.ts";
import { slots as slotsTool } from "./tools/slots.ts";
import { SlotStore } from "./lib/slot-store.ts";
import { UnitySlots } from "./lib/unity-slots.ts";
import { SlotProvisioning } from "./lib/slot-provisioning.ts";
import { definePlugin } from "@bb-kit/core/plugin";
import { overview } from "./rpc/overview.ts";
import { create } from "./rpc/create.ts";
import { attach } from "./rpc/attach.ts";
import { get } from "./rpc/get.ts";
import { saveBoard } from "./rpc/save-board.ts";
import { saveDocument } from "./rpc/save-document.ts";
import { createDocument } from "./rpc/create-document.ts";
import { createBoard } from "./rpc/create-board.ts";
import { preview } from "./rpc/preview.ts";
import { updateGame } from "./rpc/update-game.ts";
import { uploadAsset } from "./rpc/upload-asset.ts";
import { prompt } from "./rpc/prompt.ts";
import { inspectUnity } from "./rpc/inspect-unity.ts";
import { recordRequest } from "./rpc/record-request.ts";

export default definePlugin({
  pluginId: "game-studio",
  rpc: {
    listUnityEditors,
    overview,
    create,
    attach,
    get,
    saveBoard,
    saveDocument,
    createDocument,
    createBoard,
    preview,
    updateGame,
    uploadAsset,
    prompt,
    inspectUnity,
    recordRequest,
  },
  rpcPublication: { discoverable: true },
  command: { manage: manageCommand, slots: slotsCommand },
  services(bb) {
    const slotStore = new SlotStore(bb.storage.database());
    const unityEditors = createUnityEditors(bb, slotStore);
    const ensureLegacyClaims = legacyClaimsGuard(bb, unityEditors.claims.db);
    const unitySlots = new UnitySlots(bb, slotStore, ensureLegacyClaims);
    return {
      unityEditors,
      unitySlots,
      slotProvisioning: new SlotProvisioning(bb, unitySlots),
      ensureLegacyClaims,
    };
  },
  setup({ unitySlots }) {
    unitySlots.install();
  },
  agents: {
    files: instructionFiles(import.meta.url),
    tools: { manage: manageTool, slots: slotsTool },
    skills: ["game-studio", "unity-editors"],
  },
});
