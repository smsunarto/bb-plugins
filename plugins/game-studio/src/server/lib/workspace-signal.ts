import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  studioHostSignals,
  workspaceChangedChannel,
  type WorkspaceChanged,
} from "../../shared/canvas-contract.ts";
import { studioHostContract } from "../../shared/host-contract.ts";

/**
 * Passes on what hosts see change in the canvases open studios read lately:
 * an agent's edits, a generation landing, another studio's save. Returns the
 * unsubscribe.
 */
export function relayCanvasChanges(bb: Pick<BbPluginApi, "hosts" | "realtime">): () => void {
  const client = bb.hosts.experimental_client({
    contract: studioHostContract,
    experimental_signals: studioHostSignals,
  });
  return client.experimental_onSignal("canvasChanged", ({ payload }) => {
    const signal: WorkspaceChanged = payload;
    bb.realtime.publish(workspaceChangedChannel, signal);
  });
}

/**
 * A BB run this plugin started stopped. Its status lives in BB, not on disk,
 * so the studio showing its job hears it here and reads again.
 */
export function publishRunEnded(
  bb: Pick<BbPluginApi, "pluginId" | "realtime">,
  thread: { id: string; originPluginId: string | null },
): void {
  if (thread.originPluginId !== bb.pluginId) return;
  const signal: WorkspaceChanged = { threadId: thread.id };
  bb.realtime.publish(workspaceChangedChannel, signal);
}
