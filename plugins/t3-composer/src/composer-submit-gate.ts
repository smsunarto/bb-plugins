import type { ExperimentalComposerAction } from "@get-bb/plugin-sdk/app";

/** What the composer knows when deciding whether an action may run, as BB reports it. */
export interface ComposerSubmitContext {
  hasSubmittableInput: boolean;
  isAttaching: boolean;
  isSubmitting: boolean;
  voiceActive: boolean;
  disabled: boolean;
  disabledReason: string | undefined;
}

export type SubmitBlocker =
  | { by: "attaching" }
  | { by: "disabled"; reason: string | undefined }
  | { by: "voice" }
  | { by: "submitting" }
  | { by: "empty" };

/**
 * The first thing stopping `action`, in priority order, or null when it may run.
 * `allowVoice` lets a finished voice transcript submit while voice input is still shown.
 */
export function submitBlocker(
  action: ExperimentalComposerAction,
  ctx: ComposerSubmitContext,
  { allowVoice = false }: { allowVoice?: boolean } = {},
): SubmitBlocker | null {
  if (ctx.isAttaching) return { by: "attaching" };
  if (ctx.disabled) return { by: "disabled", reason: ctx.disabledReason };
  if (ctx.voiceActive && !allowVoice) return { by: "voice" };
  if (ctx.isSubmitting) return { by: "submitting" };
  if (action.requiresInput && !ctx.hasSubmittableInput) return { by: "empty" };
  return null;
}

export function describeSubmitBlocker(blocker: SubmitBlocker | null): string | null {
  if (blocker === null) return null;
  switch (blocker.by) {
    case "attaching":
      return "Uploading attachments...";
    case "disabled":
      return blocker.reason ?? "This composer can't submit right now.";
    case "voice":
      return "Finish voice input first.";
    case "submitting":
      return "Submitting...";
    case "empty":
      return "Type a message first.";
  }
}
