import type { PluginProviderDeclaration } from "@get-bb/plugin-sdk";
import {
  NANOCODEX_MODELS,
  NANOCODEX_PROVIDER_ID,
  NANOCODEX_REASONING_LEVELS,
  NANOCODEX_SERVICE_TIERS,
} from "../shared/provider-catalog.ts";

export const nanocodexProvider: PluginProviderDeclaration = {
  id: NANOCODEX_PROVIDER_ID,
  displayName: "NanoCodex",
  icon: "./assets/icon.svg",
  capabilities: {
    supportsServiceTier: true,
    supportsNativeUserQuestion: false,
    fork: "checkpoint",
    supportsManualCompaction: true,
    supportsThreadArchive: false,
    supportsThreadRename: false,
    permissionModes: ["full"],
    reasoningLevels: NANOCODEX_REASONING_LEVELS,
  },
  composerActions: [],
  reasoningLevels: NANOCODEX_REASONING_LEVELS.map((id) => ({ id, label: id })),
  serviceTiers: NANOCODEX_SERVICE_TIERS,
  models: { scope: "host", fallback: NANOCODEX_MODELS },
  maintenance: { health: true, usage: false, installation: false },
  strings: {
    signInHint:
      "NanoCodex uses Codex auth.json when available and starts ChatGPT device login from provider health.",
    expiredHint: "Start ChatGPT device login from provider health.",
    installUrl: "https://github.com/gakonst/nanocodex",
  },
  env: { passthrough: ["CODEX_HOME", "NANOCODEX_AUTH_FILE", "PARALLEL_API_KEY"] },
};
