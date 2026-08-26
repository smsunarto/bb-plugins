import type { PluginProviderDeclaration } from "@get-bb/plugin-sdk";
import { AMP_AGENT } from "../src/execution-target.ts";
import { AMP_NATIVE_SKILL_ROOTS } from "./provision.ts";

/** Everything needed to launch the bundled ACP bridge. */
export interface BridgeLaunch {
  /** Executable that runs the bridge (process.execPath at registration time). */
  node: string;
  /**
   * True when `node` is an Electron binary (bb's own) rather than a plain node.
   * Electron only behaves like node when ELECTRON_RUN_AS_NODE=1 is set; without
   * it, spawning bb's binary with a script argument launches the GUI instead of
   * running the bridge, and bb's ACP client sees a silent agent.
   */
  electron: boolean;
  /** Absolute path to the bundled bridge, <plugin dir>/dist/bridge.js. */
  bridge: string;
  /** Amp CLI executable, passed to the bridge via AMP_CLI_PATH. */
  amp: string;
}

/**
 * The provider declaration for `bb.providers.register`. The bridge speaks ACP
 * to bb and drives the Amp CLI (AMP_CLI_PATH) via @ampcode/sdk. The
 * `acpLaunchSpec` mirrors the retired customAcpAgents entry, and
 * `nativeReasoning` mirrors CONFIG_MODE/AMP_MODES in src/bridge-core.ts (the
 * declaration test pins them together; server code cannot import bridge-core
 * because it would pull the devDependency-only @ampcode/sdk into the server
 * bundle). Service tiers, fork, archive, rename, and the native user question
 * stay declared off: the bridge implements none of them.
 */
export function buildAmpProviderDeclaration(launch: BridgeLaunch): PluginProviderDeclaration {
  return {
    id: AMP_AGENT.providerId,
    displayName: AMP_AGENT.displayName,
    family: "acp",
    icon: "./assets/icon.svg",
    experimental_bridgeOptions: {
      acpDialect: "generic",
      acpLaunchSpec: {
        displayName: AMP_AGENT.displayName,
        command: launch.node,
        args: [launch.bridge],
        env: {
          AMP_CLI_PATH: launch.amp,
          ...(launch.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
        },
        nativeSkillRoots: AMP_NATIVE_SKILL_ROOTS,
        nativeReasoning: {
          configId: "amp-mode",
          supportedLevels: ["low", "medium", "high", "ultra"],
          defaultLevel: "medium",
        },
      },
    },
    maintenance: { health: true },
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      fork: "none",
      supportsManualCompaction: false,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      permissionModes: ["accept-edits", "full"],
      reasoningLevels: ["low", "medium", "high", "ultra"],
    },
    composerActions: [],
  };
}
