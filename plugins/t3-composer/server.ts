import { definePlugin } from "@bb-kit/core/plugin";
import { draftDispatchDecision } from "./src/draft-dispatch";

export default definePlugin({
  pluginId: "t3-composer",
  rpc: {},
  setup({ bb }) {
    bb.experimental_hooks.on("message.dispatch", (context) =>
      draftDispatchDecision({ pluginId: bb.pluginId, context }),
    );
  },
});
