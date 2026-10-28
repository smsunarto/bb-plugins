import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { DEVIN_PROVIDER_ID } from "../shared/devin.ts";
import { cloudProjectInstructions } from "./lib/cloud-context.ts";
import { devinProviderDeclaration } from "./lib/declaration.ts";
import { openTargetStore, type TargetsContext } from "./lib/targets.ts";
import { cloudIntent, cloudIntentContract } from "./rpc/cloud-intent.ts";
import { cloudSession, cloudSessionContract } from "./rpc/cloud-session.ts";
import { setCloudIntent, setCloudIntentContract } from "./rpc/set-cloud-intent.ts";

export const contract = defineRpcContract({
  cloudIntent: cloudIntentContract,
  setCloudIntent: setCloudIntentContract,
  cloudSession: cloudSessionContract,
});

export default async function plugin(bb: BbPluginApi): Promise<void> {
  const ctx: TargetsContext = Object.freeze({ bb, targets: openTargetStore(bb) });
  const { targets: store } = ctx;
  bb.rpc.register(contract, {
    cloudIntent: () => cloudIntent(ctx),
    setCloudIntent: (input) => setCloudIntent(ctx, input),
    cloudSession: (input) => cloudSession(ctx, input),
  });

  // A missing Devin CLI does not stop registration: the bridge reports it
  // as not installed and bb shows the provider as unavailable.
  bb.providers.register(devinProviderDeclaration(store));
  // Cloud threads open with a note naming the project's repository, because
  // the VM only sees what Devin's org defaults to. Claiming here pins the
  // thread the same way deriveProviderOptions does.
  bb.agents.configure((session) => {
    const none = { tools: [], skills: [] };
    if (session.provider.id !== DEVIN_PROVIDER_ID || store.claim(session.thread.id) !== "cloud")
      return none;
    const instructions = cloudProjectInstructions(session.project.gitRemoteUrl);
    return instructions === undefined ? none : { ...none, instructions };
  });
  bb.events.on("thread.deleted", ({ thread }) => store.forget(thread.id));
}
