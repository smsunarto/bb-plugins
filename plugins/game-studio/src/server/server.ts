import { instructionFiles } from "@bb-kit/core/instructions";
import { definePlugin } from "@bb-kit/core/plugin";
import { manage as manageCommand } from "./command/manage.ts";
import { slots as slotsCommand } from "./command/slots.ts";
import { mountBridge } from "./lib/bridge.ts";
import { legacyClaimsGuard } from "./lib/legacy-claims.ts";
import { registerNodeMention } from "./lib/node-mention.ts";
import { registerRequestMention } from "./lib/request-mention.ts";
import { SlotProvisioning } from "./lib/slot-provisioning.ts";
import { SlotStore } from "./lib/slot-store.ts";
import { defineStudioSettings, StudioClient } from "./lib/studio-client.ts";
import { createUnityEditors } from "./lib/unity-editors.ts";
import { UnitySlots } from "./lib/unity-slots.ts";
import { listUnityEditors } from "./rpc/list-unity-editors.ts";
import { nameThread } from "./rpc/name-thread.ts";
import { overview } from "./rpc/overview.ts";
import { canvasContext } from "./tools/canvas-context.ts";
import { canvasEdit } from "./tools/canvas-edit.ts";
import { generate3dAsset } from "./tools/generate-3d-asset.ts";
import { generateCanvasMedia } from "./tools/generate-canvas-media.ts";
import { generateImage } from "./tools/generate-image.ts";
import { generateVideo } from "./tools/generate-video.ts";
import { generation } from "./tools/generation.ts";
import { manage as manageTool } from "./tools/manage.ts";
import { slots as slotsTool } from "./tools/slots.ts";

/*
 * Game Studio in bb: the studio itself is a web app; this plugin embeds it beside the thread,
 * gives agents tools that call its API, relays its approvals into the thread, and lends it bb
 * threads through the bridge. Unity Editors and checkout slots still run here, on bb machines.
 */

/** The bridge protocol this plugin speaks; the Worker reads it from `/ping`. */
const BRIDGE_VERSION = "1";

export default definePlugin({
  pluginId: "game-studio",
  rpc: { overview, nameThread, listUnityEditors },
  rpcPublication: { discoverable: true },
  command: { manage: manageCommand, slots: slotsCommand },
  services(bb) {
    const slotStore = new SlotStore(bb.storage.database());
    const unityEditors = createUnityEditors(bb, slotStore);
    const ensureLegacyClaims = legacyClaimsGuard(bb, unityEditors.claims.db);
    const unitySlots = new UnitySlots(bb, slotStore, ensureLegacyClaims);
    return {
      studio: new StudioClient(defineStudioSettings(bb)),
      unityEditors,
      unitySlots,
      slotProvisioning: new SlotProvisioning(bb, unitySlots),
      ensureLegacyClaims,
    };
  },
  setup({ bb, studio, unitySlots }) {
    mountBridge(bb, BRIDGE_VERSION);
    registerRequestMention(bb, studio);
    registerNodeMention(bb, studio);
    unitySlots.install();
  },
  agents: {
    files: instructionFiles(import.meta.url),
    tools: {
      manage: manageTool,
      slots: slotsTool,
      generate_image: generateImage,
      generate_video: generateVideo,
      generate_3d_asset: generate3dAsset,
      generate_canvas_media: generateCanvasMedia,
      generation,
      canvas_context: canvasContext,
      canvas_edit: canvasEdit,
    },
    skills: ["game-studio", "unity-editors", "assemble-unity-scene"],
  },
});
