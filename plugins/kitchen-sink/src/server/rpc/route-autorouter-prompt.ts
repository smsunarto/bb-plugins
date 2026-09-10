import { defineQuery } from "@bb-kit/core/rpc";
import {
  routeAutorouterPromptInputSchema,
  routeAutorouterPromptOutputSchema,
} from "../../shared/autorouter/contract.ts";
import { routeComposerPrompt } from "../lib/autorouter/route-composer.ts";

export const routeAutorouterPrompt = defineQuery({
  input: routeAutorouterPromptInputSchema,
  output: routeAutorouterPromptOutputSchema,
  execute: async ({ bb }, input) => ({ decision: await routeComposerPrompt(bb, input) }),
});
