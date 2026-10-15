import { instructionFiles } from "@bb-kit/core/instructions";
import { definePlugin } from "@bb-kit/core/plugin";
import { manage as manageCommand } from "./command/manage.ts";
import { manage as manageTool } from "./tools/manage.ts";
import { createUnityEditors } from "./lib/unity-editors.ts";
import { listUnityEditors } from "./rpc/list-unity-editors.ts";
import { legacyClaimsGuard } from "./lib/legacy-claims.ts";

export default definePlugin({
  pluginId: "unity",
  rpc: { listUnityEditors },
  rpcPublication: {
    discoverable: true,
    description: "Unity Editor discovery, checkout slots and public ownership information.",
  },
  command: { manage: manageCommand },
  services(bb) {
    const unityEditors = createUnityEditors(bb);
    return {
      unityEditors,
      ensureLegacyClaims: legacyClaimsGuard(bb, unityEditors.claims.db),
    };
  },
  agents: {
    files: instructionFiles(import.meta.url),
    tools: { manage: manageTool },
    skills: ["unity-editors"],
  },
});
