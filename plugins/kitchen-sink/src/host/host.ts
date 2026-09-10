import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { completeCodexInference } from "@bb-plugins/codex-inference/client";
import { toAiServiceFailure } from "@bb-plugins/codex-inference/failure";
import { autorouterHostContract } from "../shared/autorouter/contract.ts";

export default experimental_defineHostEntry({
  contract: autorouterHostContract,
  handlers: {
    async complete(input) {
      try {
        return await completeCodexInference(input);
      } catch (error) {
        return toAiServiceFailure(error);
      }
    },
  },
});
