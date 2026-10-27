import type { MessageDispatchHookContext, MessageDispatchHookDecision } from "@get-bb/plugin-sdk";

// Match BB's Drafts hook using this plugin's identity: composer.submit attributes
// experimental_data to the plugin that called it.
export function draftDispatchDecision({
  pluginId,
  context,
}: {
  pluginId: string;
  context: MessageDispatchHookContext;
}): MessageDispatchHookDecision {
  const submission = context.experimental_submission;
  const isNewDraft =
    submission?.pluginId === pluginId &&
    submission.data !== null &&
    typeof submission.data === "object" &&
    !Array.isArray(submission.data) &&
    submission.data.kind === "draft";
  const firstQueuedMessage = context.queuedMessages[0];
  const isQueuedDraft =
    firstQueuedMessage?.waitingOn?.kind === "plugin" &&
    firstQueuedMessage.waitingOn.pluginId === pluginId;
  return isNewDraft || isQueuedDraft ? { action: "wait", reason: "Draft" } : { action: "proceed" };
}
