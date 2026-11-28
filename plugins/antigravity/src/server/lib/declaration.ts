import type { JsonValue, PluginProviderDeclaration } from "@get-bb/plugin-sdk";
import type { PermissionMode } from "@get-bb/plugin-sdk/provider-bridge";
import type { AcpLaunchSpec } from "@get-bb/plugin-sdk/provider-bridge/acp";
import {
  ANTIGRAVITY_DIALECT_ID,
  ANTIGRAVITY_PROVIDER_ID,
  parseAntigravitySettings,
  type AntigravitySettings,
} from "../../shared/antigravity.ts";

/** Default sessionless and local launch spec (`agy acp`). */
export const ANTIGRAVITY_DEFAULT_LAUNCH = {
  displayName: "Antigravity",
  command: "agy",
  args: ["acp"],
  env: {},
} satisfies AcpLaunchSpec;

export function buildAntigravityLaunchSpec(args: {
  settings: AntigravitySettings;
  permissionMode?: PermissionMode;
}): AcpLaunchSpec {
  const command = args.settings.executablePath.trim() || ANTIGRAVITY_DEFAULT_LAUNCH.command;
  const launchArgs = ["acp"];
  if (args.settings.sandboxEnabled && args.permissionMode !== "full") {
    launchArgs.push("--sandbox");
  }
  if (args.settings.disableTelemetry) {
    launchArgs.push("--disable-telemetry");
  }
  const defaultAgent = args.settings.defaultAgent.trim();
  if (defaultAgent !== "") {
    launchArgs.push("--agent", defaultAgent);
  }
  return {
    displayName: ANTIGRAVITY_DEFAULT_LAUNCH.displayName,
    command,
    args: launchArgs,
    env: {},
  };
}

function isDefaultLaunchSpec(spec: AcpLaunchSpec): boolean {
  return (
    spec.command === ANTIGRAVITY_DEFAULT_LAUNCH.command &&
    spec.args.length === ANTIGRAVITY_DEFAULT_LAUNCH.args.length &&
    spec.args.every((arg, index) => arg === ANTIGRAVITY_DEFAULT_LAUNCH.args[index])
  );
}

/**
 * First-class Google Antigravity provider declaration.
 *
 * The host bridge (`src/host/host.ts`) wraps `@get-bb/plugin-sdk/provider-bridge/acp`
 * with the `antigravity` dialect, translating bb permission modes (`accept-edits`,
 * `auto`, `full`) and `/plan` turns onto `agy acp` session modes, enriching
 * `model/list` with immediate reasoning-effort discovery, and serving health,
 * quota, and CLI install/update maintenance.
 */
export function antigravityProviderDeclaration(): PluginProviderDeclaration {
  return {
    id: ANTIGRAVITY_PROVIDER_ID,
    displayName: "Antigravity",
    family: "acp",
    icon: "./assets/icon.svg",
    strings: {
      signInHint: "Run `agy` or `agy acp --login` on the machine to sign in.",
      expiredHint: "Your Antigravity session expired. Run `agy` or `agy acp --login`, then reload.",
      installUrl: "https://antigravity.google/docs/getting-started",
      planModeCopy: "Antigravity will plan carefully before executing.",
      iconTint: { light: "#111827", dark: "#F5F5F5" },
    },
    experimental_visibility: "always",
    experimental_bridgeOptions: {
      acpDialect: ANTIGRAVITY_DIALECT_ID,
      acpLaunchSpec: ANTIGRAVITY_DEFAULT_LAUNCH,
    },
    models: { scope: "host" },
    maintenance: { health: true, usage: true, installation: true },
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      supportsManualCompaction: true,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      fork: "none",
      permissionModes: ["accept-edits", "auto", "full"],
      reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
    },
    reasoningLevels: [
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
      { id: "xhigh", label: "Extra High" },
      { id: "max", label: "Max" },
    ],
    composerActions: ["plan"],
    experimental_nativeSkillRoots: {
      user: [".gemini/config/skills", ".agents/skills"],
      project: [
        { path: ".agents/skills", ancestors: true },
        { path: ".agent/skills", ancestors: true },
        { path: "_agents/skills", ancestors: true },
        { path: "_agent/skills", ancestors: true },
      ],
    },
    experimental_resolvesNativeRoots: true,
    env: {
      passthrough: [
        "BB_ANTIGRAVITY_EXECUTABLE",
        "GEMINI_API_KEY",
        "GOOGLE_GEMINI_BASE_URL",
        "GOOGLE_CLOUD_PROJECT",
        "GOOGLE_CLOUD_LOCATION",
        "AGY_ADC_AUTH",
      ],
    },
    deriveProviderOptions(context): Record<string, JsonValue> {
      const settings = parseAntigravitySettings(context.settings);
      const launchSpec = buildAntigravityLaunchSpec({
        settings,
        permissionMode: context.permissionMode,
      });
      return isDefaultLaunchSpec(launchSpec) ? {} : { acpLaunchSpec: launchSpec };
    },
  };
}
