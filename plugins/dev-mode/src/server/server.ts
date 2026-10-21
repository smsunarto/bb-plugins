import { definePlugin } from "@bb-kit/core/plugin";
import { principle } from "./command/principle.ts";
import { configuration } from "./lib/scope.ts";

export default definePlugin({
  // The stored identity predates the rename; users and agents see Dev Mode.
  pluginId: "scott-engineering",
  publicName: "dev-mode",
  rpc: {},
  command: { principle },
  setup({ bb }) {
    bb.agents.configure(configuration);
  },
});
