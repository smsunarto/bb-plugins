import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { completeCodexInference } from "@bb-plugins/codex-inference/client";
import { toAiServiceFailure } from "@bb-plugins/codex-inference/failure";
import { gtdSidebarHostContract } from "./lib/host-contract.ts";

export default experimental_defineHostEntry({
  contract: gtdSidebarHostContract,
  handlers: {
    "codex.ai.complete": async (input, context) => {
      try {
        return { ok: true as const, text: await completeCodexInference(input, context.signal) };
      } catch (error) {
        return toAiServiceFailure(error);
      }
    },
  },
});
