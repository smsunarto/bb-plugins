import { defineRpcContract, type ExperimentalHostClient } from "@get-bb/plugin-sdk";
import { codexAiHostContract, type CodexAiTextResult } from "@bb-plugins/codex-inference/contract";
import { gitButlerHostContract } from "./gitbutler-contract.ts";

/**
 * The plugin's own host entry. Thread naming runs on the host because that is
 * where the user's Codex login lives; the GitButler probe runs there because
 * that is where the checkout is.
 */
export const gtdSidebarHostContract = defineRpcContract({
  ...gitButlerHostContract,
  "codex.ai.complete": codexAiHostContract["codex.ai.complete"],
});

export type GtdSidebarHostClient = ExperimentalHostClient<typeof gtdSidebarHostContract>;
export type GtdSidebarCodexResult = CodexAiTextResult;
