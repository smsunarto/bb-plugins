import { definePlugin } from "@bb-kit/core/plugin";
import { status } from "./command/status.ts";
import { nanocodexProvider } from "./provider-declaration.ts";

export default definePlugin({
  pluginId: "nanocodex",
  rpc: {},
  command: { status },
  setup(bb) {
    bb.providers.register(nanocodexProvider);
  },
});
