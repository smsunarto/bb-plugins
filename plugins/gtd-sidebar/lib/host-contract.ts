import { defineRpcContract, type ExperimentalHostClient } from "@get-bb/plugin-sdk";
import { codexAiHostContract, type CodexAiTextResult } from "@bb-plugins/codex-inference/contract";

/**
 * The plugin's own host entry. Thread naming runs on the host because that is
 * where the user's Codex login lives.
 */
export const gtdSidebarHostContract = defineRpcContract({
  "codex.ai.complete": codexAiHostContract["codex.ai.complete"],
});

export type GtdSidebarHostClient = ExperimentalHostClient<typeof gtdSidebarHostContract>;
export type GtdSidebarCodexResult = CodexAiTextResult;
