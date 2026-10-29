import { describe, expect, it } from "vitest";
import type { ExperimentalComposerAction } from "@get-bb/plugin-sdk/app";
import {
  describeSubmitBlocker,
  submitBlocker,
  type ComposerSubmitContext,
} from "./composer-submit-gate";

const send: ExperimentalComposerAction = {
  kind: "send",
  requiresInput: true,
  shortcut: { label: "Enter", ariaKeyshortcuts: "Enter" },
  run: () => {},
};
const steer: ExperimentalComposerAction = { ...send, kind: "steer", requiresInput: false };

const idle: ComposerSubmitContext = {
  hasSubmittableInput: true,
  isAttaching: false,
  isSubmitting: false,
  voiceActive: false,
  disabled: false,
  disabledReason: undefined,
};
const everything: ComposerSubmitContext = {
  hasSubmittableInput: false,
  isAttaching: true,
  isSubmitting: true,
  voiceActive: true,
  disabled: true,
  disabledReason: "Pick a project first.",
};

describe("submitBlocker", () => {
  it.each<[string, ComposerSubmitContext, string | null]>([
    ["lets an idle composer with a draft submit", idle, null],
    ["reports uploads before anything else", everything, "Uploading attachments..."],
    [
      "reports the host's reason before voice, submitting and an empty draft",
      { ...everything, isAttaching: false },
      "Pick a project first.",
    ],
    [
      "does not ask for input when the host disables without a reason",
      { ...everything, isAttaching: false, disabledReason: undefined },
      "This composer can't submit right now.",
    ],
    [
      "reports voice input before submitting and an empty draft",
      { ...everything, isAttaching: false, disabled: false },
      "Finish voice input first.",
    ],
    [
      "reports submitting before an empty draft",
      { ...everything, isAttaching: false, disabled: false, voiceActive: false },
      "Submitting...",
    ],
    ["asks for input last", { ...idle, hasSubmittableInput: false }, "Type a message first."],
  ])("%s", (_name, ctx, reason) => {
    expect(describeSubmitBlocker(submitBlocker(send, ctx))).toBe(reason);
  });

  it("lets a steer run on an empty draft", () => {
    expect(submitBlocker(steer, { ...idle, hasSubmittableInput: false })).toBeNull();
  });

  it("lets a finished voice transcript through while voice input is still shown", () => {
    const ctx = { ...idle, voiceActive: true };
    expect(submitBlocker(send, ctx)).toEqual({ by: "voice" });
    expect(submitBlocker(send, ctx, { allowVoice: true })).toBeNull();
  });
});
