import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

// An inline prompt is a bb user-tier skill whose SKILL.md frontmatter has `inline: true`. Picking
// it from the `/` menu inserts a pill that sends the skill's body with the message, instead of a
// skill reference the agent has to load. Shared by the server entry and the app bundle; keep it
// free of server-only imports.

export const T3_COMPOSER_PLUGIN_ID = "t3-composer";
export const INLINE_PROMPT_PROVIDER_ID = "inline-prompts";
export const INLINE_PROMPTS_TAG = "inline-prompts";

export const inlinePromptsContract = defineRpcContract({
  inlinePrompts: {
    input: z.null(),
    output: z.object({ names: z.array(z.string()) }),
    tags: () => [INLINE_PROMPTS_TAG],
  },
});
