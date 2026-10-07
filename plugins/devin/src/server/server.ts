import { definePlugin } from "@bb-kit/core/plugin";
import { DEVIN_PROVIDER_ID } from "../shared/devin.ts";
import { cloudProjectInstructions } from "./lib/cloud-context.ts";
import { devinProviderDeclaration } from "./lib/declaration.ts";
import { openTargetStore } from "./lib/targets.ts";
import { cloudIntent } from "./rpc/cloud-intent.ts";
import { cloudSession } from "./rpc/cloud-session.ts";
import { setCloudIntent } from "./rpc/set-cloud-intent.ts";

export default definePlugin({
  pluginId: "devin",
  rpc: { cloudIntent, setCloudIntent, cloudSession },
  services: (bb) => ({ targets: openTargetStore(bb) }),
  setup({ bb, targets: store }) {
    // A missing Devin CLI does not stop registration: the bridge reports it
    // as not installed and bb shows the provider as unavailable.
    bb.providers.register(devinProviderDeclaration(store));
    // Cloud threads open with a note naming the project's repository, because
    // the VM only sees what Devin's org defaults to. Claiming here pins the
    // thread the same way deriveProviderOptions does.
    bb.agents.configure((ctx) => {
      const none = { tools: [], skills: [] };
      if (ctx.provider.id !== DEVIN_PROVIDER_ID || store.claim(ctx.thread.id) !== "cloud")
        return none;
      const instructions = cloudProjectInstructions(ctx.project.gitRemoteUrl);
      return instructions === undefined ? none : { ...none, instructions };
    });
    bb.events.on("thread.deleted", ({ thread }) => store.forget(thread.id));
  },
});
