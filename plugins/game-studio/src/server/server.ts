import { canvasEdit } from "./tools/canvas-edit.ts";
import { canvasContext as canvasContextRpc } from "./rpc/canvas-context.ts";
import { canvasContext } from "./tools/canvas-context.ts";
import { generation } from "./tools/generation.ts";
import { generateCanvasMedia } from "./tools/generate-canvas-media.ts";
import { generate3dAsset } from "./tools/generate-3d-asset.ts";
import { generateVideo } from "./tools/generate-video.ts";
import { generateImage } from "./tools/generate-image.ts";
import { Generations } from "./lib/generations.ts";
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
import { syncWorkspace } from "./rpc/sync-workspace.ts";
import { publishRunEnded, relayCanvasChanges } from "./lib/workspace-signal.ts";
import { saveBoard } from "./rpc/save-board.ts";
import { saveDocument } from "./rpc/save-document.ts";
import { createDocument } from "./rpc/create-document.ts";
import { createBoard } from "./rpc/create-board.ts";
import { preview } from "./rpc/preview.ts";
import { modelEvidence } from "./rpc/model-evidence.ts";
import { updateGame } from "./rpc/update-game.ts";
import { uploadAsset } from "./rpc/upload-asset.ts";
import { prompt } from "./rpc/prompt.ts";
import { inspectUnity } from "./rpc/inspect-unity.ts";
import { recordRequest } from "./rpc/record-request.ts";
import { FalOAuth } from "./lib/fal-oauth.ts";
import { falAuth } from "./rpc/fal-auth.ts";
import { auth } from "./command/auth.ts";
import { generateCanvas } from "./rpc/generate-canvas.ts";
import { cancelCanvasRun } from "./rpc/cancel-canvas-run.ts";
import { generationGrant } from "./rpc/generation-grant.ts";
import { undoCanvasEdit } from "./rpc/undo-canvas-edit.ts";
import { canvasGenerationStatus } from "./rpc/canvas-generation-status.ts";
import { briefTemplates } from "./rpc/brief-templates.ts";
import { registerRequestMention } from "./lib/request-mention.ts";
import { registerNodeMention } from "./lib/node-mention.ts";

export default definePlugin({
  pluginId: "game-studio",
  rpc: {
    canvasContext: canvasContextRpc,
    briefTemplates,
    generateCanvas,
    cancelCanvasRun,
    generationGrant,
    undoCanvasEdit,
    canvasGenerationStatus,
    falAuth,
    listUnityEditors,
    overview,
    create,
    attach,
    get,
    syncWorkspace,
    saveBoard,
    saveDocument,
    createDocument,
    createBoard,
    preview,
    modelEvidence,
    updateGame,
    uploadAsset,
    prompt,
    inspectUnity,
    recordRequest,
  },
  rpcPublication: { discoverable: true },
  command: { manage: manageCommand, slots: slotsCommand, auth },
  services(bb) {
    const slotStore = new SlotStore(bb.storage.database());
    const unityEditors = createUnityEditors(bb, slotStore);
    const ensureLegacyClaims = legacyClaimsGuard(bb, unityEditors.claims.db);
    const unitySlots = new UnitySlots(bb, slotStore, ensureLegacyClaims);
    const generationSettings = bb.settings.define({
      vertexProject: {
        type: "string",
        label: "Google Cloud project (Vertex AI)",
        description:
          "Project ID billed for Nano Banana 2.1 and Gemini Omni. Each project host signs in with `gcloud auth application-default login`.",
      },
      falOAuthCredentials: {
        type: "string",
        label: "Fal OAuth session (managed)",
        secret: true,
        description: "Managed by browser sign-in. Stores refresh authorization for Fal H3 Max.",
      },
    });
    const falOAuth = new FalOAuth({
      read: async () => (await generationSettings.get()).falOAuthCredentials,
      save: async (value) => {
        await generationSettings.experimental_set({ falOAuthCredentials: value });
      },
    });
    bb.onDispose(() => falOAuth.dispose());
    const generations = new Generations(
      bb,
      async (provider) => ({
        vertexProject: (await generationSettings.get()).vertexProject?.trim() || undefined,
        ...(provider === "fal" ? { falAccessToken: await falOAuth.accessToken() } : {}),
      }),
      slotStore,
    );
    bb.onDispose(() => generations.dispose());
    return {
      falOAuth,
      generations,
      unityEditors,
      unitySlots,
      slotProvisioning: new SlotProvisioning(bb, unitySlots),
      ensureLegacyClaims,
    };
  },
  setup({ bb, unitySlots }) {
    bb.onDispose(relayCanvasChanges(bb));
    bb.events.on("thread.idle", ({ thread }) => publishRunEnded(bb, thread));
    bb.events.on("thread.failed", ({ thread }) => publishRunEnded(bb, thread));
    registerRequestMention(bb);
    bb.onDispose(registerNodeMention(bb));
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
    skills: ["game-studio", "unity-editors", "assemble-unity-scene", "rive-ui-design"],
  },
});
