import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { gitbutlerHostContract, gitbutlerHostSignals } from "../../shared/host-contract.ts";
import {
  WORKSPACE_CHANGED_CHANNEL,
  type RepositoryChanged,
  type TurnEnded,
} from "../../shared/panel.ts";

/**
 * An agent's writes come in a burst that ends with its turn. Saying so lets an
 * open panel show them now rather than on its next poll. Panels listen by
 * environment, not by thread, because a Create PR or Resolve conflicts
 * subthread writes to its parent's environment. The thread and its parent
 * ride along for the panel to tell its own turns from a sibling's. A thread
 * with no environment changed no workspace.
 */
export function publishWorkspaceChanged(
  bb: Pick<BbPluginApi, "realtime">,
  thread: { id: string; environmentId: string | null; parentThreadId: string | null },
): void {
  if (thread.environmentId === null) return;
  const payload: TurnEnded = {
    environmentId: thread.environmentId,
    threadId: thread.id,
    parentThreadId: thread.parentThreadId,
  };
  bb.realtime.publish(WORKSPACE_CHANGED_CHANNEL, payload);
}

/**
 * Passes on what the hosts see change in the repositories panels read
 * lately: the reader's own commits in a terminal, GitButler desktop, another
 * agent. The host names the repository by its path, so the machine rides
 * along. Returns the unsubscribe.
 */
export function relayRepositoryChanges(bb: Pick<BbPluginApi, "hosts" | "realtime">): () => void {
  const client = bb.hosts.experimental_client({
    contract: gitbutlerHostContract,
    experimental_signals: gitbutlerHostSignals,
  });
  return client.experimental_onSignal("repositoryChanged", ({ hostId, payload }) => {
    const signal: RepositoryChanged = { hostId, ...payload };
    bb.realtime.publish(WORKSPACE_CHANGED_CHANNEL, signal);
  });
}
