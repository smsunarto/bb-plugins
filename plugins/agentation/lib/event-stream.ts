// Timing of the `/events` stream, shared by the server that writes it and the
// toolbar that supervises it, so neither can drift from the other.

/** How often the server writes a `ping` frame on an idle stream. Well under
 *  the 100 s Cloudflare drops an idle response after. */
export const STREAM_HEARTBEAT_MS = 25_000;

/** How soon EventSource reconnects on its own after a dropped stream. */
export const STREAM_RETRY_MS = 3_000;

/** Silence after which the toolbar treats the stream as dead: two missed
 *  heartbeats plus slack for a slow relay. */
export const STREAM_SILENCE_MS = STREAM_HEARTBEAT_MS * 2 + 10_000;

/** What a `change` frame carries. */
export type StreamChange = {
  type: string;
  sessionId: string | null;
  cursor: number;
  at: string;
};

/** True when a change can move one toolbar session: a change scoped to some
 *  other session cannot, while an unscoped one (config, routing, staging)
 *  might. */
export function changeConcernsSession(change: unknown, sessionId: string | null): boolean {
  if (typeof change !== "object" || change === null) return true;
  const scoped = (change as Partial<StreamChange>).sessionId;
  return typeof scoped !== "string" || sessionId === null || scoped === sessionId;
}
