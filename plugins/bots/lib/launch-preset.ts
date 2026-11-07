import { z } from "zod";
import type { NewThreadComposerProps } from "@get-bb/plugin-sdk/app";

export const launchPresetSchema = z
  .object({
    execution: z
      .object({
        providerId: z.string().trim().min(1, "Choose a harness for the preferred model."),
        model: z.string().trim().min(1, "Choose a preferred model."),
        reasoningLevel: z.string().min(1),
        serviceTier: z.string().min(1).optional(),
        permissionMode: z.enum(["accept-edits", "auto", "full"]).nullable(),
      })
      .strict()
      .nullable(),
    workspace: z.enum(["checkout", "worktree"]),
    initialPrompt: z.string().max(8192),
  })
  .strict();
export type LaunchPreset = z.infer<typeof launchPresetSchema>;

export function emptyLaunchPreset(): LaunchPreset {
  return { execution: null, workspace: "checkout", initialPrompt: "" };
}

// Seeds are captured with the conversation target. The submitted request always
// wins; never apply a saved preset again on the server after the user edits it.
export function launchComposerSeeds(
  preset: LaunchPreset | null | undefined,
): Partial<NewThreadComposerProps> {
  if (!preset) return {};
  const execution = preset.execution;
  return {
    ...(preset.initialPrompt ? { initialPrompt: preset.initialPrompt } : {}),
    ...(execution
      ? {
          defaultProviderId: execution.providerId,
          defaultModel: execution.model,
          defaultReasoningLevel: execution.reasoningLevel,
          ...(execution.serviceTier === undefined
            ? {}
            : { defaultServiceTier: execution.serviceTier }),
          ...(execution.permissionMode === null
            ? {}
            : { defaultPermissionMode: execution.permissionMode }),
        }
      : {}),
  };
}
