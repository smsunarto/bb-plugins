import { definePlugin } from "@bb-kit/core/plugin";
import { devinProviderDeclaration } from "./lib/declaration.ts";
import { setupTargetStore } from "./lib/targets.ts";
import { cloudIntent } from "./rpc/cloud-intent.ts";
import { cloudSession } from "./rpc/cloud-session.ts";
import { setCloudIntent } from "./rpc/set-cloud-intent.ts";

export default definePlugin({
  pluginId: "devin",
  rpc: { cloudIntent, setCloudIntent, cloudSession },
  setup(bb) {
    const store = setupTargetStore(bb);
    // A missing Devin CLI does not stop registration: the bridge reports it
    // as not installed and bb shows the provider as unavailable.
    bb.providers.register(devinProviderDeclaration(store));
    bb.events.on("thread.deleted", ({ thread }) => store.forget(thread.id));
  },
});
