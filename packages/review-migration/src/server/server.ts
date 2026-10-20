import { definePlugin } from "@bb-kit/core/plugin";
import { migration } from "./rpc/migration.ts";

export default definePlugin({
  pluginId: "review",
  rpc: { migration },
  services(bb) {
    const settings = bb.settings.define({
      claudeModel: {
        type: "string",
        label: "Previous Claude reviewer model",
        default: "claude-opus-5-5[1m]",
      },
      codexModel: {
        type: "string",
        label: "Previous Codex reviewer model",
        default: "gpt-6-astra",
      },
    });
    return { db: bb.storage.database(), models: () => settings.get() };
  },
});
