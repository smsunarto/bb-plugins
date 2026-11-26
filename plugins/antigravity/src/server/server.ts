import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { antigravityProviderDeclaration } from "./lib/declaration.ts";
import { registerUsageSource } from "./lib/usage-source.ts";

export default function plugin(bb: BbPluginApi): void {
  bb.settings.define({
    sandboxEnabled: {
      type: "boolean",
      label: "Terminal sandbox",
      description:
        "Run Antigravity commands inside its OS terminal sandbox in Accept Edits and Auto modes.",
      default: false,
    },
    disableTelemetry: {
      type: "boolean",
      label: "Disable telemetry",
      description: "Launch `agy acp` with `--disable-telemetry`.",
      default: false,
    },
    defaultAgent: {
      type: "string",
      label: "Default agent",
      description:
        "Optional custom Antigravity agent name passed via `--agent` (leave blank for default).",
      default: "",
    },
    executablePath: {
      type: "string",
      label: "agy executable path",
      description:
        "Optional absolute path to the `agy` binary. Leave blank to resolve `agy` from PATH (or BB_ANTIGRAVITY_EXECUTABLE).",
      default: "",
    },
  });

  bb.providers.register(antigravityProviderDeclaration());
  registerUsageSource(bb);
}
