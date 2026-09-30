import type { JsonValue, PluginProviderDeclaration } from "@get-bb/plugin-sdk";
import type { AcpLaunchSpec } from "@get-bb/plugin-sdk/provider-bridge/acp";
import { DEVIN_PROVIDER_ID } from "../../shared/devin.ts";
import type { TargetStore } from "./targets.ts";

/** The local agent. Also the sessionless launch: model listing and health
 *  checks always probe the local CLI. */
export const DEVIN_LOCAL_LAUNCH = {
  displayName: "Devin",
  command: "devin",
  args: ["acp"],
  env: {},
} satisfies AcpLaunchSpec;

/** `--cloud` relays the same ACP stream to a Devin Cloud VM. */
export const DEVIN_CLOUD_LAUNCH = {
  displayName: "Devin Cloud",
  command: "devin",
  args: ["acp", "--cloud"],
  env: {},
} satisfies AcpLaunchSpec;

const CLAUDE_SKILLS_ROOT = { path: ".claude/skills", skipIfManifest: ".claude-plugin/plugin.json" };

/**
 * Devin runs through the SDK's generic ACP bridge (src/host/host.ts). Each
 * thread's first command pins it to the local agent or Devin Cloud
 * (src/server/lib/targets.ts), and every command after that launches the
 * same one.
 */
export function devinProviderDeclaration(store: TargetStore): PluginProviderDeclaration {
  return {
    id: DEVIN_PROVIDER_ID,
    displayName: "Devin",
    family: "acp",
    icon: "./assets/icon.svg",
    strings: {
      signInHint: "Run `devin auth login` on the machine to sign in.",
      expiredHint: "Your Devin session expired. Run `devin auth login`, then reload.",
      installUrl: "https://cli.devin.ai/docs",
    },
    experimental_bridgeOptions: { acpLaunchSpec: DEVIN_LOCAL_LAUNCH },
    models: { scope: "host" },
    maintenance: { health: true },
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      supportsManualCompaction: false,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      // Devin's ACP server advertises no session fork.
      fork: "none",
      // Devin ignores permission flags in ACP mode and always starts in its
      // Code mode. The bridge auto-allows every request under Full and asks bb
      // otherwise, so both modes hold without a launch flag.
      permissionModes: ["accept-edits", "full"],
      reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
    },
    composerActions: [],
    experimental_nativeSkillRoots: {
      user: [".config/devin/skills", ".agents/skills", CLAUDE_SKILLS_ROOT],
      project: [".devin/skills", ".agents/skills", CLAUDE_SKILLS_ROOT],
    },
    deriveProviderOptions: ({ threadId }): Record<string, JsonValue> =>
      store.claim(threadId) === "cloud" ? { acpLaunchSpec: DEVIN_CLOUD_LAUNCH } : {},
  };
}
