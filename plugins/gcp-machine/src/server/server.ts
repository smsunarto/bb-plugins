import { definePlugin } from "@bb-kit/core/plugin";
import { createService } from "./lib/service.ts";
import { status } from "./command/status.ts";
import { wake } from "./command/wake.ts";
export default definePlugin({
  pluginId: "gcp-machine",
  rpc: {},
  command: { status, wake },
  services: (bb) => ({ gcp: createService(bb) }),
  setup: ({ gcp }) => gcp.register(),
});
