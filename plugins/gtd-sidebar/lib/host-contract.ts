import { defineRpcContract } from "@get-bb/plugin-sdk";
import type { z } from "zod";
import {
  aiInferenceCompleteInputSchema,
  aiInferenceCompleteOutputSchema,
} from "@bb-plugins/codex-inference/contract";
import { gitButlerHostContract } from "./gitbutler-contract.ts";
import { gitHubHostContract } from "./github-host.ts";
import { sharedDirectoryHostContract } from "./shared-directory-host.ts";

/**
 * The plugin's own host entry. Thread naming runs on the host because that is
 * where the user's Codex login lives; the GitButler probe and GitHub polling
 * run there because that is where the checkout and the user's gh auth are.
 */
export const gtdSidebarHostContract = defineRpcContract({
  ...gitButlerHostContract,
  ...gitHubHostContract,
  ...sharedDirectoryHostContract,
  "ai.inference.complete": {
    input: aiInferenceCompleteInputSchema,
    output: aiInferenceCompleteOutputSchema,
  },
});

export type GtdSidebarAiInferenceCompleteInput = z.infer<typeof aiInferenceCompleteInputSchema>;
export type GtdSidebarAiInferenceCompleteOutput = z.infer<typeof aiInferenceCompleteOutputSchema>;
