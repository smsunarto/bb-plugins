import type { Context } from "@bb-kit/core/plugin";
import { deliver } from "./delivery.ts";
import {
  BODY_MAX_CHARS,
  oneLine,
  parseSeconds,
  plainText,
  suppressionReason,
  threadLabel,
} from "./format.ts";
import { latestRunWasManuallyStopped } from "./lifecycle.ts";
import { projectName } from "./project-names.ts";
import { runTracker } from "./run-tracker.ts";
import { pluginSettings } from "./settings.ts";

export type NotifiableThread = {
  id: string;
  projectId: string;
  title: string | null;
  titleFallback: string | null;
  visibility: "visible" | "hidden";
  parentThreadId: string | null;
};

async function wasManuallyStopped(bb: Context["bb"], threadId: string): Promise<boolean> {
  try {
    return await latestRunWasManuallyStopped((args) =>
      bb.sdk.threads.events.list({ threadId, ...args }),
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    bb.log.warn(`could not inspect stop reason for ${threadId}: ${detail}`);
    return false;
  }
}

/**
 * Product rule for a finished or failed thread. Events call this. Not an RPC.
 */
export async function notifyThread(
  bb: Context["bb"],
  thread: NotifiableThread,
  outcome: "finished" | "failed",
  detail: string | null,
): Promise<void> {
  const settings = pluginSettings(bb);
  const suppressed = suppressionReason(thread, {
    includeHiddenThreads: settings.includeHiddenThreads,
    includeChildThreads: settings.includeChildThreads,
  });
  if (suppressed !== null) return;

  const tracker = runTracker(bb);
  if (outcome === "finished" && (await wasManuallyStopped(bb, thread.id))) {
    tracker.cancel(thread.id);
    return;
  }

  const minRunMs = parseSeconds(settings.minRunSeconds) * 1000;
  await tracker.notifyOnce(thread.id, minRunMs, async () => {
    const project = await projectName(bb, thread.projectId);
    const fallback = outcome === "failed" ? "Thread failed." : "Turn finished.";
    const said = oneLine(plainText(detail?.trim() || fallback), BODY_MAX_CHARS);
    await deliver(bb, {
      project,
      heading: threadLabel(thread),
      message: outcome === "failed" ? `Failed — ${said}` : said,
    });
  });
}
