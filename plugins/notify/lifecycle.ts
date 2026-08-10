export const THREAD_EVENT_PAGE_SIZE = 100;

interface ThreadEvent {
  seq: number;
  type: string;
  data: unknown;
}

type ListThreadEvents = (args: {
  afterSeq?: string;
  limit: string;
}) => Promise<ThreadEvent[]>;

function interruptionReason(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const reason = (data as { reason?: unknown }).reason;
  return typeof reason === "string" ? reason : null;
}

/**
 * Read the complete event log and identify how its latest run ended.
 *
 * The curated `thread.idle` plugin event does not include an idle reason. The
 * durable `system/thread/interrupted` event does, so it is the source of truth.
 * Comparing it with the latest turn request or start prevents an old manual
 * stop from suppressing a later run that completed normally.
 */
export async function latestRunWasManuallyStopped(
  listEvents: ListThreadEvents,
): Promise<boolean> {
  let afterSeq: number | undefined;
  let latestRunSeq = 0;
  let latestInterruptionSeq = 0;
  let latestInterruptionReason: string | null = null;

  while (true) {
    const events = await listEvents({
      ...(afterSeq === undefined ? {} : { afterSeq: String(afterSeq) }),
      limit: String(THREAD_EVENT_PAGE_SIZE),
    });

    for (const event of events) {
      if (
        event.type === "client/turn/requested" ||
        event.type === "turn/started"
      ) {
        latestRunSeq = Math.max(latestRunSeq, event.seq);
      } else if (
        event.type === "system/thread/interrupted" &&
        event.seq >= latestInterruptionSeq
      ) {
        latestInterruptionSeq = event.seq;
        latestInterruptionReason = interruptionReason(event.data);
      }
    }

    if (events.length < THREAD_EVENT_PAGE_SIZE) break;
    const nextAfterSeq = events.at(-1)?.seq;
    if (nextAfterSeq === undefined || nextAfterSeq === afterSeq) break;
    afterSeq = nextAfterSeq;
  }

  return (
    latestInterruptionSeq > latestRunSeq &&
    latestInterruptionReason === "manual-stop"
  );
}
