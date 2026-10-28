import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { draftDispatchDecision } from "./src/draft-dispatch";

export default async function plugin(bb: BbPluginApi): Promise<void> {
  bb.experimental_hooks.on("message.dispatch", (context) =>
    draftDispatchDecision({ pluginId: bb.pluginId, context }),
  );
}
