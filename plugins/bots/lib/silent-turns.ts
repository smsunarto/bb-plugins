import type { BbPluginApi } from "@get-bb/plugin-sdk";

interface ReadState {
  id: string;
  lastReadAt: number | null;
  latestAttentionAt: number;
}

const MARK_READ_DEADLINE_MS = 1500;
const isRead = (thread: ReadState) => (thread.lastReadAt ?? 0) >= thread.latestAttentionAt;

/**
 * Keeps a bot's silent turn from notifying. A bot may answer a subthread's
 * report or an FYI with no reply at all; bb still sends a "Finished and
 * waiting for you" push for that turn. bb holds a finished turn's push for
 * about two seconds and drops it once the thread is read, so a turn that ends
 * with no assistant text is marked read as soon as it goes idle.
 *
 * Only a thread that was read when the turn began is marked, so an earlier
 * reply the user has not seen stays unread.
 */
export function createSilentTurns(
  bb: BbPluginApi,
  isBotThread: (thread: { id: string; parentThreadId: string | null }) => boolean,
) {
  // Bot threads that were read when their current turn began.
  const readAtStart = new Set<string>();
  bb.events.on("thread.active", ({ thread }) => {
    if (isBotThread(thread) && isRead(thread)) readAtStart.add(thread.id);
    else readAtStart.delete(thread.id);
  });
  bb.events.on("thread.failed", ({ thread }) => {
    readAtStart.delete(thread.id);
  });
  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    if (!readAtStart.delete(thread.id) || lastAssistantText?.trim()) return;
    void bb.sdk.threads
      .markRead({ threadId: thread.id, signal: AbortSignal.timeout(MARK_READ_DEADLINE_MS) })
      .catch((error: unknown) =>
        bb.log.warn(
          `Marking silent turn read failed for ${thread.id}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
  });
  bb.onDispose(() => readAtStart.clear());
}
